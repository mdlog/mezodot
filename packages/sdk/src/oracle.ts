import { concatHex, encodeAbiParameters, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { oracleRouterAbi, priceSourceAbi, supraPullAbi } from './abis';
import type { HubDeployment } from './deployments';
import { PRICE_KEYS, PRICE_SYMBOLS, symbolForPriceKey, type PositionState, type PriceSymbol, type ProtocolState } from './reader';
import type { UsdPrices } from './valuation';

/**
 * OracleRouter v2 helpers (contracts/src/hub/OracleRouter.sol). Prices come from Pyth Core, pushed on
 * Mezo by Mezo's own pusher, and from keyless Supra DORA proofs that a caller attaches to its transaction.
 * Every update passed as `bytes[] priceUpdate` is `sourceTag (1 byte) ‖ vendor payload`.
 */

/** OracleRouter source tags, as registered by contracts/script/DeployHub.s.sol. */
export const SOURCE_TAG = { PYTH: 1, SUPRA: 2 } as const;
export type SourceTag = (typeof SOURCE_TAG)[keyof typeof SOURCE_TAG];

/** Seconds a price must stay valid after a transaction is built (wallet confirmation + inclusion). */
export const PRICE_MARGIN_SEC = 90;

const with0x = (s: string): Hex => (s.startsWith('0x') ? s : `0x${s}`) as Hex;
const wadToNumber = (v: bigint): number => Number(v) / 1e18;

export const tagUpdate = (tag: SourceTag, payload: Hex): Hex => concatHex([toHex(tag, { size: 1 }), payload]);

// --- Router state ------------------------------------------------------------------

export type FeedLeg = { source: number; maxAge: number; id: Hex };
export type OracleFeed = { primary: FeedLeg; secondary: FeedLeg | null; maxConfBps: number; maxDivergenceBps: number };
/** A leg's stored value, read from its source; `usable` applies the router's age and confidence rules. */
export type LegState = FeedLeg & { price: bigint; conf: bigint; publishTime: number; usable: boolean };

export type OracleStatus = {
  symbol: PriceSymbol;
  /** Router configuration for the key; null when the key has no feed. */
  feed: OracleFeed | null;
  /** Whether a strict read (OracleRouter.getPrice) succeeds now. */
  ok: boolean;
  /** Strict price in WAD when `ok`, else 0n. */
  price: bigint;
  /** Unix seconds until which the key stays available (0 when unavailable). */
  validUntil: number;
  /** Newest stored value across the legs, without freshness checks (views only), and its publish time. */
  lastPrice: bigint;
  publishTime: number;
  /** Primary then secondary leg (empty when unconfigured). */
  legs: LegState[];
};

export type OracleState = Record<PriceSymbol, OracleStatus>;

const BPS = 10_000n;

/** Reads feed config, strict availability, every leg's stored value and the last value for each symbol. */
export async function readOracle(client: PublicClient, hub: HubDeployment): Promise<OracleState> {
  const address = hub.contracts.oracleRouter;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const sourceAddress = new Map<number, Promise<Address>>();
  const sourceOf = (tag: number) => {
    if (!sourceAddress.has(tag)) sourceAddress.set(tag, client.readContract({ address, abi: oracleRouterAbi, functionName: 'sources', args: [tag] }));
    return sourceAddress.get(tag)!;
  };
  const readLeg = async (leg: FeedLeg, maxConfBps: number): Promise<LegState> => {
    const [price, conf, publishTime] = await client
      .readContract({ address: await sourceOf(leg.source), abi: priceSourceAbi, functionName: 'latest', args: [leg.id] })
      .catch(() => [0n, 0n, 0n] as const); // the router treats a reverting source as missing too
    const age = nowSec > publishTime ? nowSec - publishTime : 0n;
    const usable = price > 0n && publishTime > 0n && age <= BigInt(leg.maxAge) && conf * BPS <= price * BigInt(maxConfBps);
    return { ...leg, price, conf, publishTime: Number(publishTime), usable };
  };
  const rows = await Promise.all(
    PRICE_SYMBOLS.map(async (symbol): Promise<OracleStatus> => {
      const key = PRICE_KEYS[symbol];
      const [feed, [ok, price, validUntil], [lastPrice, publishTime]] = await Promise.all([
        client.readContract({ address, abi: oracleRouterAbi, functionName: 'feeds', args: [key] }),
        client.readContract({ address, abi: oracleRouterAbi, functionName: 'getPriceInfo', args: [key] }),
        client.readContract({ address, abi: oracleRouterAbi, functionName: 'getPriceUnsafe', args: [key] }),
      ]);
      const leg = (l: { source: number; maxAge: number; id: Hex }): FeedLeg | null =>
        l.source === 0 ? null : { source: l.source, maxAge: l.maxAge, id: l.id };
      const primary = leg(feed.primary);
      const secondary = leg(feed.secondary);
      const legs = await Promise.all([primary, secondary].filter((l): l is FeedLeg => l !== null).map((l) => readLeg(l, feed.maxConfBps)));
      return {
        symbol,
        feed: primary ? { primary, secondary, maxConfBps: feed.maxConfBps, maxDivergenceBps: feed.maxDivergenceBps } : null,
        ok,
        price,
        validUntil: Number(validUntil),
        lastPrice,
        publishTime: Number(publishTime),
        legs,
      };
    }),
  );
  return Object.fromEntries(rows.map((r) => [r.symbol, r])) as OracleState;
}

/** Price symbols of every collateral `position` holds and every debt it owes. */
export function positionSymbols(protocol: ProtocolState, position: PositionState | null): PriceSymbol[] {
  const wanted = new Set<PriceSymbol>();
  for (const d of position?.debts ?? []) {
    if (d.amount === 0n) continue;
    const symbol = symbolForPriceKey(protocol.markets.find((m) => m.id === d.marketId)?.priceKey ?? '0x');
    if (symbol) wanted.add(symbol);
  }
  for (const c of position?.collateral ?? []) {
    if (c.balance === 0n) continue;
    const symbol = symbolForPriceKey(protocol.collaterals.find((x) => x.id === c.id)?.priceKey ?? '0x');
    if (symbol) wanted.add(symbol);
  }
  return PRICE_SYMBOLS.filter((s) => wanted.has(s));
}

/**
 * Price symbols VaultManager reads in a risk-checked call by `position`'s account (borrow, withdraw,
 * loop, unwind, liquidation): every debt and every held collateral, plus `borrowSymbol` for new debt.
 * A debt-free account that borrows nothing needs no prices at all.
 */
export function riskCheckSymbols(protocol: ProtocolState, position: PositionState | null, borrowSymbol?: PriceSymbol): PriceSymbol[] {
  const hasDebt = position?.debts.some((d) => d.amount > 0n) ?? false;
  if (!hasDebt && !borrowSymbol) return [];
  const held = positionSymbols(protocol, position);
  return PRICE_SYMBOLS.filter((s) => s === borrowSymbol || held.includes(s));
}

/** Symbols whose strict price is unavailable now or expires within `marginSec`. */
export function staleSymbols(oracle: OracleState, symbols: PriceSymbol[], nowSec: number, marginSec = PRICE_MARGIN_SEC): PriceSymbol[] {
  return symbols.filter((s) => !oracle[s].ok || oracle[s].validUntil < nowSec + marginSec);
}

// --- Prices for valuation ---------------------------------------------------------------

export type FreshPrice = { price: number; publishTime: number; source: 'pyth' | 'supra' };

/**
 * USD prices VaultManager would accept now: the router's strict price, else a fresh pull price that is
 * about to be posted. Symbols with neither are omitted, so their collateral counts as zero for limits,
 * as in VaultManager's conservative mode.
 */
export function usablePrices(oracle: OracleState, fresh: Partial<Record<PriceSymbol, FreshPrice>> = {}): UsdPrices {
  const out: UsdPrices = {};
  for (const s of PRICE_SYMBOLS) {
    if (oracle[s]?.ok) out[s] = wadToNumber(oracle[s].price);
    else if (fresh[s]) out[s] = fresh[s].price;
  }
  return out;
}

/**
 * Prices a transaction sees after attaching `fresh` pull updates (what a keeper should value with).
 * A refreshed leg changes the price only where the router would select it: it is the primary, or the
 * primary is not usable. Elsewhere the stored strict price stands (e.g. USDC while Mezo's Pyth push
 * is fresh). Divergence between legs is left to the transaction simulation.
 */
export function pricesAfterUpdate(oracle: OracleState, fresh: Partial<Record<PriceSymbol, FreshPrice>>): UsdPrices {
  const out = usablePrices(oracle);
  for (const s of PRICE_SYMBOLS) {
    const f = fresh[s];
    const primary = oracle[s]?.legs[0];
    if (!f || !primary) continue;
    const tag = f.source === 'supra' ? SOURCE_TAG.SUPRA : SOURCE_TAG.PYTH;
    if (primary.source === tag || !primary.usable) out[s] = f.price;
  }
  return out;
}

/** Last known prices for display (TVL, balances): usable prices, else the newest stored value. */
export function displayPrices(oracle: OracleState, fresh: Partial<Record<PriceSymbol, FreshPrice>> = {}): UsdPrices {
  const out = usablePrices(oracle, fresh);
  for (const s of PRICE_SYMBOLS) {
    if (out[s] === undefined && oracle[s]?.lastPrice > 0n) out[s] = wadToNumber(oracle[s].lastPrice);
  }
  return out;
}

// --- Agent relay (browsers cannot call Supra: its JSON endpoint rejects CORS preflights) --------------

export type OracleUpdate = {
  /** Tagged updates for `bytes[] priceUpdate`. */
  updates: Hex[];
  /** Decoded prices of `updates` (USD), for previews. */
  prices: Partial<Record<PriceSymbol, FreshPrice>>;
  /** Requested symbols the relay cannot update (e.g. Pyth push feeds on testnet). */
  missing: PriceSymbol[];
};

/** Signed pull updates for `symbols` from the Mezodot agent (`GET /oracle/update`). */
export async function fetchOracleUpdate(agentUrl: string, symbols: PriceSymbol[], fetchImpl: typeof fetch = fetch): Promise<OracleUpdate> {
  if (symbols.length === 0) return { updates: [], prices: {}, missing: [] };
  const res = await fetchImpl(`${agentUrl}/oracle/update?symbols=${symbols.join(',')}`);
  const body = (await res.json().catch(() => ({}))) as Partial<OracleUpdate> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Oracle relay error ${res.status}`);
  return { updates: body.updates ?? [], prices: body.prices ?? {}, missing: body.missing ?? [] };
}

// --- Supra DORA -------------------------------------------------------------------------------------

/** Supra pair indexes (docs.supra.com data-feed index) for the symbols Mezodot pulls. */
export const SUPRA_PAIRS: Partial<Record<PriceSymbol, number>> = { ETH: 19, USDC: 89, BTC: 18 };

/** Fetches a signed proof for `pairs` from a Supra DORA `get_proof` endpoint (no key needed). */
export async function fetchSupraProof(url: string, pairs: number[], fetchImpl: typeof fetch = fetch): Promise<Hex> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pair_indexes: pairs, chain_type: 'evm' }),
  });
  if (!res.ok) throw new Error(`Supra proof service error ${res.status}`);
  const body = (await res.json()) as { proof_bytes?: string };
  if (!body.proof_bytes) throw new Error('Supra proof service returned no proof');
  return with0x(body.proof_bytes);
}

export type SupraRow = { pair: number; price: bigint; timestampMs: bigint; decimals: number };

/** Devnet only: the "proof" MockSupraPull accepts, abi.encode(pairs, prices, timestampsMs, decimals). */
export function encodeMockSupraProof(rows: SupraRow[]): Hex {
  const arr = { type: 'uint256[]' } as const;
  return encodeAbiParameters(
    [arr, arr, arr, arr],
    [rows.map((r) => BigInt(r.pair)), rows.map((r) => r.price), rows.map((r) => r.timestampMs), rows.map((r) => BigInt(r.decimals))],
  );
}

export type SupraPrice = { pair: number; priceWad: bigint; publishTime: number };

/**
 * Verifies a proof against Supra's pull contract by eth_call (the same check SupraSource runs on-chain)
 * and returns its prices in WAD with publish times in seconds. Reverts (throws) on an invalid proof.
 */
export async function verifySupraProof(client: PublicClient, supraPull: Address, proof: Hex): Promise<SupraPrice[]> {
  const { result } = await client.simulateContract({ address: supraPull, abi: supraPullAbi, functionName: 'verifyOracleProofV2', args: [proof] });
  return result.pairs.map((pair, i) => {
    const decimals = Number(result.decimal[i]);
    const price = result.prices[i];
    const priceWad = decimals <= 18 ? price * 10n ** BigInt(18 - decimals) : price / 10n ** BigInt(decimals - 18);
    return { pair: Number(pair), priceWad, publishTime: Number(result.timestamp[i] / 1000n) };
  });
}

export const supraPriceToUsd = (p: SupraPrice): FreshPrice => ({ price: wadToNumber(p.priceWad), publishTime: p.publishTime, source: 'supra' });
