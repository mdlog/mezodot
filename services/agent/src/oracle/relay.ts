import type { Hex } from 'viem';
import {
  NETWORKS,
  PRICE_SYMBOLS,
  SOURCE_TAG,
  encodeMockPythUpdate,
  encodeMockSupraProof,
  fetchSupraProof,
  readOracle,
  staleSymbols,
  supraPriceToUsd,
  tagUpdate,
  toPythInt,
  usablePrices,
  verifySupraProof,
  type FreshPrice,
  type OracleState,
  type OracleStatus,
  type OracleUpdate,
  type PriceSymbol,
  type UsdPrices,
} from '@mezodot/sdk';
import type { Context } from '../context';

/** Router reads are shared by everything that runs in the same tick. */
const ORACLE_CACHE_MS = 2_000;
/** One Supra proof per window, whatever the caller asked for: bounds load on Supra's public endpoint. */
const PROOF_CACHE_MS = 3_000;

/** Devnet starting prices and confidence (fraction of price, like the live MUSD/MEZO feeds). */
const DEVNET_PRICES: Record<PriceSymbol, number> = { MUSD: 1, MEZO: 0.00794, ETH: 3_200, USDC: 1 };
const DEVNET_CONF: Record<PriceSymbol, number> = { MUSD: 0.0104, MEZO: 0.0057, ETH: 0.0005, USDC: 0.0005 };

type Proof = { proof: Hex; prices: Partial<Record<PriceSymbol, FreshPrice>> };

/** Supra pair index of a key's Supra leg, if it has one. */
const supraPair = (s: OracleStatus): number | null => {
  const leg = [s.feed?.primary, s.feed?.secondary].find((l) => l?.source === SOURCE_TAG.SUPRA);
  return leg ? Number(BigInt(leg.id)) : null;
};

/** Whether the relay can refresh `s`: any key with a Supra leg; on the devnet also mocked Pyth primaries. */
export const relayCanServe = (s: OracleStatus, env: string): boolean =>
  supraPair(s) !== null || (env === 'devnet' && s.feed?.primary.source === SOURCE_TAG.PYTH);

export type Pricing = {
  oracle: OracleState;
  /** Pull updates the transaction must attach. */
  update: OracleUpdate;
  /** Prices VaultManager would accept for a transaction sent now. */
  prices: UsdPrices;
  /** Requested symbols without any acceptable price (strict reads of them would revert). */
  unpriced: PriceSymbol[];
};

/**
 * Serves signed pull updates (`GET /oracle/update`) and prices risk checks for the keeper.
 * Testnet: keyless Supra DORA proofs, fetched server-side because Supra's JSON endpoint rejects browser
 * CORS preflights, and verified by eth_call before they are served. Pyth push feeds cannot be pulled
 * without a Hermes key, so they are reported as missing. Devnet: the same paths with MockSupraPull proofs
 * and MockPyth payloads at prices the e2e scripts can move.
 */
export class OracleRelay {
  private readonly mockPrices: Record<PriceSymbol, number> | null;
  private oracleCache: { at: number; value: Promise<OracleState> } | null = null;
  private proofCache: { at: number; value: Promise<Proof> } | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.mockPrices = ctx.config.env === 'devnet' ? { ...DEVNET_PRICES } : null;
  }

  /** Router state (feeds, strict availability, last values). */
  oracle(): Promise<OracleState> {
    const t = this.now();
    if (!this.oracleCache || t - this.oracleCache.at > ORACLE_CACHE_MS) {
      const value = readOracle(this.ctx.hub.client, this.ctx.hub.deployment);
      this.oracleCache = { at: t, value };
      value.catch(() => {
        if (this.oracleCache?.value === value) this.oracleCache = null;
      });
    }
    return this.oracleCache.value;
  }

  /** Devnet only: moves the mock prices served from now on. */
  setMockPrices(update: Partial<Record<PriceSymbol, number>>): Record<PriceSymbol, number> {
    if (!this.mockPrices) throw new Error('Mock prices exist only on the devnet');
    for (const [k, v] of Object.entries(update)) {
      if (k in this.mockPrices && typeof v === 'number' && Number.isFinite(v) && v > 0) this.mockPrices[k as PriceSymbol] = v;
    }
    this.proofCache = null;
    return { ...this.mockPrices };
  }

  /** Signed updates for `symbols`: one Supra proof for keys with a Supra leg; on the devnet also MockPyth. */
  async update(symbols: PriceSymbol[]): Promise<OracleUpdate> {
    const wanted = PRICE_SYMBOLS.filter((s) => symbols.includes(s));
    const out: OracleUpdate = { updates: [], prices: {}, missing: [] };
    if (wanted.length === 0) return out;
    const oracle = await this.oracle();
    const pairs = PRICE_SYMBOLS.flatMap((s) => {
      const p = supraPair(oracle[s]);
      return p === null ? [] : [[s, p] as const];
    });
    const viaSupra = new Set(pairs.map(([s]) => s));
    if (wanted.some((s) => viaSupra.has(s))) {
      const { proof, prices } = await this.supraProof(pairs);
      out.updates.push(tagUpdate(SOURCE_TAG.SUPRA, proof));
      for (const s of wanted) if (prices[s]) out.prices[s] = prices[s];
    }
    const publishTime = this.mockPrices ? await this.mockTime() : 0;
    for (const s of wanted) {
      if (viaSupra.has(s)) continue;
      const feed = oracle[s].feed;
      if (this.mockPrices && feed?.primary.source === SOURCE_TAG.PYTH) {
        const price = this.mockPrices[s];
        const conf = toPythInt(price * DEVNET_CONF[s]);
        out.updates.push(tagUpdate(SOURCE_TAG.PYTH, encodeMockPythUpdate(feed.primary.id, toPythInt(price), conf, -8, BigInt(publishTime))));
        out.prices[s] = { price, publishTime, source: 'pyth' };
      } else {
        out.missing.push(s);
      }
    }
    return out;
  }

  /** What a transaction sent now would see for `symbols`, and the pull updates it must attach. */
  async pricing(symbols: PriceSymbol[]): Promise<Pricing> {
    const oracle = await this.oracle();
    const stale = staleSymbols(oracle, symbols, Math.floor(this.now() / 1000));
    const update = stale.length > 0 ? await this.update(stale) : { updates: [], prices: {}, missing: [] };
    const prices = usablePrices(oracle, update.prices);
    return { oracle, update, prices, unpriced: symbols.filter((s) => prices[s] === undefined) };
  }

  private supraProof(pairs: readonly (readonly [PriceSymbol, number])[]): Promise<Proof> {
    const t = this.now();
    if (!this.proofCache || t - this.proofCache.at > PROOF_CACHE_MS) {
      const value = this.fetchProof(pairs);
      this.proofCache = { at: t, value };
      value.catch(() => {
        if (this.proofCache?.value === value) this.proofCache = null;
      });
    }
    return this.proofCache.value;
  }

  private async fetchProof(pairs: readonly (readonly [PriceSymbol, number])[]): Promise<Proof> {
    const { client, deployment, network } = this.ctx.hub;
    let proof: Hex;
    if (this.mockPrices) {
      const timestampMs = BigInt(await this.mockTime()) * 1000n;
      const prices = this.mockPrices;
      proof = encodeMockSupraProof(pairs.map(([s, pair]) => ({ pair, price: toPythInt(prices[s]), timestampMs, decimals: 8 })));
    } else {
      const url = NETWORKS[network].supraProofUrl;
      if (!url) throw new Error(`No Supra proof service configured for ${network}`);
      proof = await fetchSupraProof(
        url,
        pairs.map(([, p]) => p),
        this.fetchImpl,
      );
    }
    if (!deployment.contracts.supraPull) throw new Error('Deployment has no supraPull address; redeploy the hub');
    // Same verification SupraSource runs on-chain: a proof that would revert is never served.
    const verified = await verifySupraProof(client, deployment.contracts.supraPull, proof);
    const prices: Proof['prices'] = {};
    for (const [s, pair] of pairs) {
      const row = verified.find((v) => v.pair === pair);
      if (row) prices[s] = supraPriceToUsd(row);
    }
    return { proof, prices };
  }

  /** Devnet publish time: chain time can run ahead of the wall clock (anvil time travel), never behind. */
  private async mockTime(): Promise<number> {
    const block = await this.ctx.hub.client.getBlock();
    return Math.max(Math.floor(this.now() / 1000), Number(block.timestamp));
  }
}
