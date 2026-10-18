import { join } from 'node:path';
import { erc20Abi, formatUnits, maxUint256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import {
  CLOSE_FACTOR_BPS,
  BPS,
  GAS_FLOOR,
  PRICE_SYMBOLS,
  SOURCE_TAG,
  displayPrices,
  keeperGatewayAbi,
  liquidatorShare,
  NETWORKS,
  oracleRouterAbi,
  pTokenAbi,
  pricesAfterUpdate,
  readPosition,
  readProtocol,
  riskCheckSymbols,
  symbolForPriceKey,
  tigrisRouterAbi,
  usablePrices,
  valuePosition,
  type UsdPrices,
  vaultManagerAbi,
  wormholeAdapterAbi,
  type CollateralState,
  type MarketState,
  type OracleState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '@mezodot/sdk';
import type { Context, SpokeContext } from './context';
import { quoteTigris } from './dex';
import { publicError } from './errors';
import { settleLimited } from './net';
import { OracleRelay, relayCanServe } from './oracle/relay';
import { LogWindow } from './scan';
import { JsonStore, appendArchive, sameAddress } from './store';
import { SentTransactionError, type BroadcastTx, type SendOptions, type Sent, type TxSender } from './tx';

export type { UsdPrices };

export type LiquidationPlan = {
  marketId: number;
  collateralId: number;
  /** Debt tokens to repay (wei). */
  repayAmount: bigint;
  /** Collateral units the keeper expects to receive (shares for local pTokens, token units otherwise). */
  expectedSeize: bigint;
  /** Minimum collateral units to accept: the expectation less slippage. */
  minSeize: bigint;
  repayUsd: number;
  seizeUsd: number;
  /** Oracle-valued profit: what the keeper receives minus the repayment, before gas, fees and realisation. */
  profitUsd: number;
  isRemote: boolean;
};

export type AccountEvaluation = {
  account: Address;
  healthFactor: number;
  collateralUsd: number;
  /** Collateral on spokes (USD) — used for the cross-chain borrow KPI. */
  remoteCollateralUsd: number;
  /** Σ value × LTV at fresh prices. */
  borrowLimitUsd: number;
  /** Σ value × liquidation threshold at fresh prices. */
  adjustedUsd: number;
  debtUsd: number;
  /** Price symbols VaultManager reads (strictly) to liquidate this account. */
  symbols: PriceSymbol[];
  /** Symbols in `symbols` without an acceptable price: a liquidation would revert, so there is no plan. */
  unpriced: PriceSymbol[];
  /** The most profitable pair at oracle prices (the first candidate). */
  plan: LiquidationPlan | null;
  /**
   * Every (debt market, collateral) pair a liquidation could take, most oracle profit first. The keeper prices the
   * first few at what it can realise and falls back to the next when the first does not pay (see Liquidator.choose).
   */
  candidates: LiquidationPlan[];
};

/** Whether and how a planned liquidation goes ahead once realisation, gas and fees are counted. */
export type LiquidationAssessment = {
  action: 'liquidate' | 'skip';
  /**
   * Seized collateral that has to be sold for the debt asset (BTC, and pTokens of another asset than the debt once
   * redeemed): sold on Tigris right away, or held until a sale covers the repayment.
   */
  sale: 'sell' | 'hold' | null;
  /** The plan's oracle-valued profit. */
  oracleProfitUsd: number;
  /** Profit at the price the keeper can realise (Tigris for sold collateral), net of gas and fees. */
  netProfitUsd: number;
  /** Gas (liquidation, conversion, and the spoke relay of a release), oracle update fee and Wormhole fee, in USD. */
  costsUsd: number;
  /** Tigris quote for selling the expected seizure (for pTokens, what they redeem into), in debt-asset units. */
  saleQuote: string | null;
  reason: string;
  /** The (debt market, collateral) pair assessed. */
  marketId: number;
  collateralId: number;
};

/** A pair whose realisation could not be priced: never chosen while another pair could be. */
const unpricedAssessment = (plan: LiquidationPlan, err: unknown): LiquidationAssessment => ({
  action: 'skip',
  sale: null,
  oracleProfitUsd: plan.profitUsd,
  netProfitUsd: 0,
  costsUsd: 0,
  saleQuote: null,
  reason: `could not be priced: ${publicError(err)}`,
  marketId: plan.marketId,
  collateralId: plan.collateralId,
});

/** Units of a held lot, the debt-asset units repaid for them, and the least a sale of them must return. */
export type HeldPart = { amount: bigint; cost: bigint; minProceeds: bigint };

/** Seized hub collateral not yet converted back into a debt asset (persisted: survives restarts). */
export type HeldCollateral = {
  collateralId: number;
  marketId: number;
  /** Units still held as seized (shares for pTokens). */
  amount: bigint;
  /** Debt-asset units repaid to acquire them. */
  cost: bigint;
  /** Least debt-asset units a sale of the whole amount must return (the cost, for collateral held by policy). */
  minProceeds: bigint;
  /**
   * pTokens of another asset than the debt (pMEZO seized against MUSD debt): what was already redeemed from the lot,
   * in the pool's asset (MEZO), with its share of the cost. It still has to be sold on Tigris for the debt asset.
   */
  redeemed?: HeldPart;
  since: number;
  lastTx: Hex;
};

/** What a recorded liquidator transaction does: enough to apply its receipt whenever it is found. */
export type PendingAction =
  | { type: 'liquidation'; account: Address; marketId: number; collateralId: number; sale: 'sell' | 'hold' | null; remote: boolean }
  /**
   * `sell`: the pool's asset is not the debt asset, so what the redeem pays out (its Withdraw event, else
   * `expectedAssets`) joins the lot's `redeemed` part.
   */
  | { type: 'redeem'; lot: string; pool: Address; shares: bigint; sell: boolean; expectedAssets: bigint }
  | { type: 'swap'; lot: string; stage: 'seized' | 'redeemed'; amount: bigint; proceedsToken: Address };

/**
 * A liquidator transaction, recorded before it is broadcast and kept until chain state settles it: a receipt of one
 * of its own transactions applies what it did, another transaction holding its nonce means it never happened. A send
 * that gave up after broadcasting (stuck, unreadable receipts, a shutdown) is so neither lost nor applied twice.
 */
export type PendingTx = {
  action: PendingAction;
  nonce: number;
  /** Every transaction signed at `nonce` for it (fee bumps included). */
  hashes: Hex[];
  sentAt: number;
  /** When chain state first showed another transaction at the nonce (dropped once that lasts DROP_CONFIRM_MS). */
  droppedAt?: number;
};

const SLIPPAGE_BPS = 200;
/** Parallel position reads (each is ~19 eth_calls; Multicall3 batches them where deployed). */
const POSITION_READ_CONCURRENCY = 8;
/** Consecutive zero-debt reads before a borrower leaves the index (a lagging RPC replica can report 0 once). */
const DROP_AFTER_ZERO_READS = 3;
/** Blocks re-read below the cursor on every sync, in case an RPC replica served the previous window incompletely. */
const SYNC_OVERLAP_BLOCKS = 20n;
/** eth_getLogs windows per sync: after a long outage the index catches up over several ticks, while known borrowers are evaluated. */
const SYNC_WINDOWS_PER_TICK = 50;
/** Mezo's BTC is the chain's native coin, also exposed as this ERC-20 precompile: selling it spends gas money. */
const MEZO_BTC: Address = '0x7b7C000000000000000000000000000000000000';
const SALE_DEADLINE_SEC = 600;
/** Candidate pairs priced per liquidatable account: the best few by oracle profit. */
const MAX_ASSESSED_PLANS = 4;
/** A recorded transaction whose nonce another transaction holds is dropped once that holds this long (receipt endpoints lag). */
const DROP_CONFIRM_MS = 60_000;
/**
 * Seized spoke collateral (WETH/USDC) is paid out on its spoke, where the keeper still has to swap or bridge it
 * back into a debt asset: its realisable value is taken this much (bps) below the oracle value.
 */
export const REMOTE_REALISATION_HAIRCUT_BPS = 100;
/** Why a process that only follows the agent's state never sends (the stdio MCP server). */
export const READ_ONLY_SENDS =
  'this process follows the agent state read-only and cannot record what a keeper transaction changes: only the running agent sends (MCP write tools over its HTTP /mcp)';

const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
const minBig = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const maxBig = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a));
const priceOf = (prices: UsdPrices, key: Hex): number => {
  const s = symbolForPriceKey(key);
  return s ? (prices[s] ?? 0) : 0;
};
const isSupraUpdate = (u: Hex) => u.slice(0, 4).toLowerCase() === `0x${SOURCE_TAG.SUPRA.toString(16).padStart(2, '0')}`;
const heldKey = (collateralId: number, marketId: number) => `${collateralId}:${marketId}`;
/** Underlying units `shares` of a pool redeem for at its exchange rate (underlying per whole share). */
const sharesToAssets = (pool: MarketState, shares: bigint) => (shares * pool.exchangeRate) / 10n ** BigInt(pool.shareDecimals);

/** `amount` units taken off `part` with their pro-rata cost and minimum proceeds, and what is left (null: nothing). */
function takeFrom(part: HeldPart, amount: bigint): { taken: HeldPart; left: HeldPart | null } {
  if (amount >= part.amount) return { taken: part, left: null };
  const cost = (part.cost * amount) / part.amount;
  const minProceeds = (part.minProceeds * amount) / part.amount;
  return { taken: { amount, cost, minProceeds }, left: { amount: part.amount - amount, cost: part.cost - cost, minProceeds: part.minProceeds - minProceeds } };
}

/** How seized collateral of a pair becomes the pair's debt asset again. */
export type Realisation =
  /** Paid out on its spoke, to the keeper, once the agent relays the release. */
  | { kind: 'remote' }
  /** A pToken of the debt asset: redeemed at par. */
  | { kind: 'redeem'; pool: MarketState }
  /** Plain hub collateral (BTC): sold on Tigris. */
  | { kind: 'sell' }
  /** A pToken of another asset (pMEZO against MUSD debt): redeemed for the pool's asset, which is sold on Tigris. */
  | { kind: 'redeem-sell'; pool: MarketState };

export function realisation(protocol: ProtocolState, coll: CollateralState, market: MarketState): Realisation {
  if (coll.isRemote) return { kind: 'remote' };
  if (!coll.isShare) return { kind: 'sell' };
  const pool = protocol.markets.find((m) => sameAddress(m.pool, coll.token));
  if (!pool) throw new Error(`no market for the pool of ${coll.symbol}`);
  return sameAddress(pool.asset, market.asset) ? { kind: 'redeem', pool } : { kind: 'redeem-sell', pool };
}

/**
 * Values a position with the prices VaultManager would accept (see OracleRelay.pricing) and, if HF < 1, plans every
 * (debt, collateral) pair, repaying up to the 50% close factor (capped by keeper inventory), most profitable at
 * oracle prices first. Without a price for every held asset there is no plan: VaultManager prices liquidations
 * strictly and would revert.
 */
export function evaluateAccount(
  protocol: ProtocolState,
  position: PositionState,
  prices: UsdPrices,
  inventory: Record<number, bigint> = {},
): AccountEvaluation {
  const valued = valuePosition(protocol, position, prices);
  const collateralRows = valued.collateral.map((r) => ({ c: r.collateral, balance: r.balance, units: r.units, price: r.price, valueUsd: r.valueUsd }));
  const debtRows = valued.debts.map((d) => ({ m: d.market, amount: d.amount, price: d.price, valueUsd: d.valueUsd }));
  const summary = valued;
  const symbols = riskCheckSymbols(protocol, position);
  const unpriced = symbols.filter((s) => !((prices[s] ?? 0) > 0));

  const base = {
    account: position.account,
    healthFactor: summary.healthFactor,
    collateralUsd: summary.collateralUsd,
    remoteCollateralUsd: summary.remoteCollateralUsd,
    borrowLimitUsd: summary.borrowLimitUsd,
    adjustedUsd: summary.adjustedCollateralUsd,
    debtUsd: summary.debtUsd,
    symbols,
    unpriced,
  };
  if (!(summary.healthFactor < 1) || unpriced.length > 0) return { ...base, plan: null, candidates: [] };

  // Every (debt market, collateral) pair: bonuses differ per collateral and the scaled branch caps what a small
  // collateral can pay, so the largest collateral is not always the best.
  const candidates: LiquidationPlan[] = [];
  for (const debt of debtRows) {
    if (debt.amount === 0n || debt.price <= 0) continue;
    for (const coll of collateralRows) {
      if (coll.balance === 0n || coll.price <= 0) continue;
      const plan = planPair(debt, coll, inventory[debt.m.id], protocol.liquidationFeeBps);
      if (plan) candidates.push(plan);
    }
  }
  // Most oracle profit first; on a tie, hub collateral before spoke collateral (stable: the first found otherwise).
  candidates.sort((a, b) => (Math.abs(a.profitUsd - b.profitUsd) > 1e-9 ? b.profitUsd - a.profitUsd : Number(a.isRemote) - Number(b.isRemote)));
  return { ...base, plan: candidates[0] ?? null, candidates };
}

type DebtRow = { m: ProtocolState['markets'][number]; amount: bigint; price: number; valueUsd: number };
type CollateralRow = { c: ProtocolState['collaterals'][number]; balance: bigint; units: number; price: number; valueUsd: number };

/**
 * Mirrors VaultManager.liquidate/_seizeAmount for one pair: 50% close factor, bonus, scaled branch, and the
 * protocol's share of the bonus (`liquidationFeeBps`), which the keeper never receives.
 */
function planPair(debt: DebtRow, coll: CollateralRow, available: bigint | undefined, liquidationFeeBps = 0): LiquidationPlan | null {
  let repayAmount = (debt.amount * BigInt(CLOSE_FACTOR_BPS)) / BigInt(BPS);
  if (available !== undefined && available < repayAmount) repayAmount = available;
  if (repayAmount === 0n) return null;

  let repayUsd = toNumber(repayAmount, debt.m.decimals) * debt.price;
  let seizeUsd = (repayUsd * (BPS + coll.c.bonusBps)) / BPS;
  // Not enough collateral: the contract seizes everything and scales the repayment down.
  if (seizeUsd > coll.valueUsd) {
    const scale = coll.valueUsd / seizeUsd;
    repayAmount = BigInt(Math.floor(Number(repayAmount) * scale));
    repayUsd *= scale;
    seizeUsd = coll.valueUsd;
  }
  // What the keeper receives: the seizure minus the protocol's cut of the bonus.
  const keeperFraction = liquidatorShare(1, coll.c.bonusBps, liquidationFeeBps).toLiquidator;
  seizeUsd *= keeperFraction;
  const seizeFraction = coll.valueUsd > 0 ? seizeUsd / coll.valueUsd : 0;
  const expectedSeize = BigInt(Math.floor(Number(coll.balance) * seizeFraction));
  const minSeize = (expectedSeize * BigInt(BPS - SLIPPAGE_BPS)) / BigInt(BPS);
  return {
    marketId: debt.m.id,
    collateralId: coll.c.id,
    repayAmount,
    expectedSeize,
    minSeize,
    repayUsd,
    seizeUsd,
    profitUsd: seizeUsd - repayUsd,
    isRemote: coll.c.isRemote,
  };
}

type LiquidatorState = {
  /** VaultManager the cursor and accounts belong to (null in files written before deployment identities). */
  vaultManager: Address | null;
  cursor: bigint | null;
  accounts: Address[];
  held: Record<string, HeldCollateral>;
  /** Liquidator transactions not settled yet, by record id (see PendingTx). */
  pending: Record<string, PendingTx>;
};

/** One evaluation of every indexed borrower. */
export type Evaluation = {
  protocol: ProtocolState;
  evaluations: AccountEvaluation[];
  positions: PositionState[];
  oracle: OracleState;
  prices: UsdPrices;
  /** Keeper wallet balance of each market's asset (by market id) when the evaluation ran, less what held lots account for. */
  inventory: Record<number, bigint>;
};

export type LiquidatorTick = {
  at: number;
  /** Indexed borrowers evaluated. */
  evaluated: number;
  /** Accounts below HF 1. */
  liquidatable: number;
  liquidated: number;
  /** Liquidatable accounts left alone this tick, by reason. */
  skipped: Record<string, number>;
};

/** Accounts that still owe something. Repaid ones leave the index; a new Borrowed event brings them back. */
export const activeBorrowers = (positions: PositionState[]): Address[] => positions.filter((p) => p.debts.some((d) => d.amount > 0n)).map((p) => p.account);

/** Appends unseen accounts (case-insensitive), preserving first-seen order. */
export function mergeAccounts(existing: Address[], incoming: Address[]): Address[] {
  const seen = new Set(existing.map((a) => a.toLowerCase()));
  const out = [...existing];
  for (const a of incoming) {
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}

/** Most protocol risk first: the debt not covered by collateral at its liquidation threshold (USD). */
export const byShortfall = (a: AccountEvaluation, b: AccountEvaluation): number => b.debtUsd - b.adjustedUsd - (a.debtUsd - a.adjustedUsd);

/**
 * The Liquidated event VaultManager emitted in `receipt` (what was actually repaid and seized), for `account` when
 * given. A successful receipt without it is not a liquidation's: nothing was seized.
 */
export function liquidatedEvent(
  receipt: Pick<TransactionReceipt, 'logs'>,
  vaultManager: Address,
  account?: Address,
): { repaid: bigint; seized: bigint } | null {
  const logs = parseEventLogs({ abi: vaultManagerAbi, eventName: 'Liquidated', logs: receipt.logs ?? [] });
  const log = logs.find((l) => sameAddress(l.address, vaultManager) && (account === undefined || sameAddress(l.args.account, account)));
  return log ? { repaid: log.args.repaid, seized: log.args.seized } : null;
}

/** What a redeem paid out (ERC-4626 Withdraw of `pool` for `owner`). */
function withdrawEvent(receipt: Pick<TransactionReceipt, 'logs'>, pool: Address, owner: Address): { assets: bigint; shares: bigint } | null {
  const logs = parseEventLogs({ abi: pTokenAbi, eventName: 'Withdraw', logs: receipt.logs ?? [] });
  const log = logs.find((l) => sameAddress(l.address, pool) && sameAddress(l.args.owner, owner));
  return log ? { assets: log.args.assets, shares: log.args.shares } : null;
}

/** `token` units transferred to `to` in `receipt` (what a sale paid). */
function received(receipt: Pick<TransactionReceipt, 'logs'>, token: Address, to: Address): bigint {
  const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs ?? [] });
  return logs.filter((l) => sameAddress(l.address, token) && sameAddress(l.args.to, to)).reduce((sum, l) => sum + l.args.value, 0n);
}

/** Fee and gas-price reads shared by every candidate of one account (each read once, when first needed). */
type FeeReads = {
  hubGasPrice: () => Promise<bigint>;
  oracleFee: () => Promise<bigint>;
  messageFee: () => Promise<bigint>;
  spokeGasPrice: (spoke: SpokeContext) => Promise<bigint>;
};

const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => (p ??= read());
};

/** Watches borrowers and liquidates unhealthy positions through KeeperGateway. */
export class Liquidator {
  readonly store: JsonStore<LiquidatorState>;
  lastEvaluations: AccountEvaluation[] = [];
  lastRun: number | null = null;
  /** Keeper wallet balances of each market's asset at the last tick (formatted), for /health. */
  lastInventory: Record<string, string> = {};
  /** Assessment of each liquidatable account at the last tick (lowercased address). */
  readonly lastAssessments = new Map<string, LiquidationAssessment>();
  lastTick: LiquidatorTick | null = null;
  /** Why the last index sync failed (null when it succeeded). */
  syncError: string | null = null;
  private lastPrices: UsdPrices = {};
  private lastProtocol: ProtocolState | null = null;
  private evaluating: Promise<Evaluation> | null = null;
  private readonly window: LogWindow;
  private readonly zeroDebtReads = new Map<string, number>();
  /** Accounts with a liquidation in flight (loop or MCP tool). */
  private readonly liquidating = new Set<string>();
  /** Last reason logged per account, so a skipped account is reported once per change, not every tick. */
  private readonly reported = new Map<string, string>();
  /** Settling and converting run one at a time, in this chain. */
  private conversion: Promise<unknown> = Promise.resolve();
  /** Records (PendingTx ids) whose send() is in flight in this process: only that send applies them. */
  private readonly sending = new Set<string>();
  private recordSeq = 0;
  private readonly archivePath: string;

  constructor(
    private readonly ctx: Context,
    readonly relay: OracleRelay = new OracleRelay(ctx),
  ) {
    this.store = new JsonStore<LiquidatorState>(
      join(ctx.config.stateDir, `liquidator-${ctx.config.env}.json`),
      { vaultManager: null, cursor: null, accounts: [], held: {}, pending: {} },
      { readOnly: ctx.config.stateReadOnly },
    );
    this.archivePath = join(ctx.config.stateDir, `liquidator-${ctx.config.env}.archived.json`);
    this.window = new LogWindow(NETWORKS[ctx.hub.network]?.maxLogRange ?? 5_000n);
    this.reconcileDeployment();
  }

  /** Seized collateral not converted yet. */
  held(): HeldCollateral[] {
    return Object.values(this.store.get().held ?? {});
  }

  /** Liquidator transactions sent and not settled yet (for /health). */
  pendingTransactions(): (PendingTx & { id: string })[] {
    return Object.entries(this.store.get().pending ?? {}).map(([id, p]) => ({ id, ...p }));
  }

  /** Held collateral in whole units, for /health and /metrics. */
  heldSummary(): {
    collateral: string;
    market: string;
    amount: string;
    cost: string;
    minProceeds: string;
    since: number;
    redeemed: { asset: string; amount: string; cost: string } | null;
  }[] {
    const p = this.lastProtocol;
    return this.held().map((h) => {
      const c = p?.collaterals[h.collateralId];
      const m = p?.markets[h.marketId];
      const pool = c?.isShare ? p?.markets.find((x) => sameAddress(x.pool, c.token)) : undefined;
      const debtDecimals = m?.decimals ?? 18;
      return {
        collateral: c?.symbol ?? `#${h.collateralId}`,
        market: m?.symbol ?? `#${h.marketId}`,
        amount: formatUnits(h.amount, pool?.shareDecimals ?? c?.decimals ?? 18),
        cost: formatUnits(h.cost, debtDecimals),
        minProceeds: formatUnits(h.minProceeds, debtDecimals),
        since: h.since,
        redeemed: h.redeemed
          ? {
              asset: pool?.symbol ?? 'underlying',
              amount: formatUnits(h.redeemed.amount, pool?.decimals ?? 18),
              cost: formatUnits(h.redeemed.cost, debtDecimals),
            }
          : null,
      };
    });
  }

  /** Whether the last evaluation is recent enough to answer from (MCP tools). */
  isFresh(maxAgeMs: number, now = Date.now()): boolean {
    return this.lastRun !== null && now - this.lastRun <= maxAgeMs;
  }

  /**
   * A state file written for another VaultManager (a redeploy, or a file older than deployment identities) is not
   * resumed: the index restarts at the current deployment's start block. The old borrowers, cursor, held collateral
   * and unsettled transactions go to the archive file, so the old deployment's open debt stays visible.
   */
  private reconcileDeployment(): void {
    const vm = this.ctx.hub.deployment.contracts.vaultManager;
    const s = this.store.get();
    s.held ??= {};
    s.pending ??= {};
    if (sameAddress(s.vaultManager, vm)) return;
    // Borrowers and held collateral of the old contracts still need someone to look at them: keep them on file.
    const hadState = s.accounts.length > 0 || Object.keys(s.held).length > 0 || Object.keys(s.pending).length > 0;
    if (hadState && !this.store.readOnly) {
      appendArchive(this.archivePath, {
        archivedAt: new Date().toISOString(),
        reason: 'deployment replaced',
        vaultManager: s.vaultManager,
        cursor: s.cursor,
        accounts: s.accounts,
        held: s.held,
        pending: s.pending,
      });
      this.ctx.log('liquidator', 'borrower index belongs to another deployment: archived, re-indexing from the start block', {
        previous: s.vaultManager ?? 'unknown',
        accounts: s.accounts.length,
        file: this.archivePath,
      });
    }
    this.store.update((d) => {
      d.vaultManager = vm;
      d.cursor = null;
      d.accounts = [];
      d.held = {};
      d.pending = {};
    });
  }

  /**
   * Indexes borrowers from VaultManager.Borrowed in windows the RPC accepts (adaptive, like the relayer),
   * persisting the cursor after every window so a restart (or a long outage) resumes instead of failing forever.
   */
  async syncAccounts(): Promise<Address[]> {
    const { client, deployment } = this.ctx.hub;
    const vm = deployment.contracts.vaultManager;
    const latest = await client.getBlockNumber();
    const start = BigInt(deployment.startBlock);
    const cursor = this.store.get().cursor;
    let from = cursor === null ? start : maxBig(start, cursor - SYNC_OVERLAP_BLOCKS);
    for (let windows = 0; from <= latest && windows < SYNC_WINDOWS_PER_TICK; windows++) {
      let to = latest;
      let logs: { args: { account?: Address } }[] = [];
      for (;;) {
        to = from + this.window.size - 1n < latest ? from + this.window.size - 1n : latest;
        try {
          logs = await client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'Borrowed', fromBlock: from, toBlock: to });
          this.window.succeeded();
          break;
        } catch (err) {
          if (!this.window.shrink(err)) throw err;
          this.ctx.log('liquidator', 'log range refused, shrinking window', { window: String(this.window.size) });
        }
      }
      const next = to + 1n;
      this.store.update((s) => {
        s.accounts = mergeAccounts(
          s.accounts,
          logs.flatMap((l) => (l.args.account ? [l.args.account] : [])),
        );
        if (s.cursor === null || next > s.cursor) s.cursor = next;
        s.vaultManager = vm;
      });
      from = next;
    }
    return this.store.get().accounts;
  }

  /**
   * Values every indexed borrower (one evaluation at a time: concurrent callers share it). A failing index sync
   * or position read skips only that part: known accounts are still evaluated. Pull prices are fetched once for
   * the union of symbols the accounts need.
   */
  evaluateAll(): Promise<Evaluation> {
    this.evaluating ??= this.evaluateNow().finally(() => (this.evaluating = null));
    return this.evaluating;
  }

  private async evaluateNow(): Promise<Evaluation> {
    const { client, deployment } = this.ctx.hub;
    const [syncError, protocol] = await Promise.all([
      this.syncAccounts().then(
        () => null,
        (err: unknown) => err,
      ),
      readProtocol(client, deployment),
    ]);
    if (syncError) {
      const message = publicError(syncError);
      if (this.syncError !== message) this.ctx.log('liquidator', 'borrower index sync failed; evaluating known accounts', { error: message });
      this.syncError = message;
    } else this.syncError = null;
    const accounts = this.store.get().accounts;
    const [inventory, reads] = await Promise.all([
      this.inventory(protocol),
      settleLimited(accounts, POSITION_READ_CONCURRENCY, (a) => readPosition(client, deployment, protocol, a)),
    ]);
    const positions: PositionState[] = [];
    const failed: { account: Address; error: string }[] = [];
    reads.forEach((r, i) => {
      if (r.status === 'fulfilled') positions.push(r.value);
      else failed.push({ account: accounts[i], error: publicError(r.reason) });
    });
    // One line per tick, not one per account: an RPC outage would otherwise log every indexed borrower.
    if (failed.length > 0)
      this.ctx.log('liquidator', 'position reads failed; those accounts wait for the next tick', {
        failed: failed.length,
        of: accounts.length,
        first: failed[0],
      });
    // Held collateral is priced too: its sale is bounded by the oracle value.
    const heldSymbols = this.held().flatMap((h) =>
      [protocol.collaterals[h.collateralId]?.priceKey, protocol.markets[h.marketId]?.priceKey].map((k) => (k ? symbolForPriceKey(k) : undefined)),
    );
    const symbols = PRICE_SYMBOLS.filter((s) => heldSymbols.includes(s) || positions.some((p) => riskCheckSymbols(protocol, p).includes(s)));
    const { oracle, prices } = await this.keeperPricing(symbols).catch(async (err: unknown) => {
      // Pull prices down (e.g. Supra unreachable): keep going with what the router already accepts.
      this.ctx.log('liquidator', 'pull prices unavailable', { error: publicError(err) });
      const oracle = await this.relay.oracle();
      return { oracle, prices: usablePrices(oracle), updates: [] as Hex[] };
    });
    const evaluations = positions.map((p) => evaluateAccount(protocol, p, prices, inventory));
    this.dropRepaid(positions);
    this.lastInventory = Object.fromEntries(protocol.markets.map((m) => [m.symbol, formatUnits(inventory[m.id] ?? 0n, m.decimals)]));
    this.lastEvaluations = evaluations;
    this.lastPrices = prices;
    this.lastProtocol = protocol;
    this.lastRun = Date.now();
    return { protocol, evaluations, positions, oracle, prices, inventory };
  }

  /** Removes borrowers that read as debt-free several times in a row. */
  private dropRepaid(positions: PositionState[]): void {
    const active = new Set(activeBorrowers(positions).map((a) => a.toLowerCase()));
    const repaid = new Set<string>();
    for (const p of positions) {
      const a = p.account.toLowerCase();
      if (active.has(a)) {
        this.zeroDebtReads.delete(a);
        continue;
      }
      const n = (this.zeroDebtReads.get(a) ?? 0) + 1;
      this.zeroDebtReads.set(a, n);
      if (n >= DROP_AFTER_ZERO_READS) repaid.add(a);
    }
    if (repaid.size === 0) return;
    for (const a of repaid) this.zeroDebtReads.delete(a);
    this.store.update((s) => void (s.accounts = s.accounts.filter((a) => !repaid.has(a.toLowerCase()))));
  }

  /** Fresh evaluation of one account (MCP trigger_liquidation), with the keeper's inventory and pull prices. */
  async evaluateOne(account: Address): Promise<{ protocol: ProtocolState; evaluation: AccountEvaluation; prices: UsdPrices }> {
    const { client, deployment } = this.ctx.hub;
    const protocol = await readProtocol(client, deployment);
    const [position, inventory] = await Promise.all([readPosition(client, deployment, protocol, account), this.inventory(protocol)]);
    const { prices } = await this.keeperPricing(riskCheckSymbols(protocol, position));
    return { protocol, evaluation: evaluateAccount(protocol, position, prices, inventory), prices };
  }

  /**
   * Prices a liquidation sees after attaching every pull update the relay can serve for `symbols`. A keeper
   * posts the newest proof itself, so a stored but outdated pull price must not hide a liquidatable account.
   */
  async keeperPricing(symbols: PriceSymbol[]): Promise<{ oracle: OracleState; prices: UsdPrices; updates: Hex[] }> {
    const oracle = await this.relay.oracle();
    const servable = symbols.filter((s) => relayCanServe(oracle[s], this.ctx.config.env));
    const update = servable.length > 0 ? await this.relay.update(servable) : { updates: [], prices: {}, missing: [] };
    return { oracle, prices: pricesAfterUpdate(oracle, update.prices), updates: update.updates };
  }

  /** Pull updates a liquidation of `e` attaches (the relay caches proofs for a few seconds). */
  async updatesFor(e: AccountEvaluation): Promise<Hex[]> {
    return (await this.keeperPricing(e.symbols)).updates;
  }

  /**
   * The liquidation to send for `e`: its best few candidates (by oracle profit) priced at what the keeper can
   * realise. Among those worth sending, one realised right away (sold, redeemed or paid on a spoke) goes before one
   * whose seizure would be held, then the higher net profit wins. When none is worth sending, the assessment with
   * the highest net profit says why (action 'skip').
   */
  async choose(
    protocol: ProtocolState,
    e: AccountEvaluation,
    prices: UsdPrices,
    updates: Hex[],
  ): Promise<{ plan: LiquidationPlan; assessment: LiquidationAssessment }> {
    const candidates = (e.candidates?.length ? e.candidates : e.plan ? [e.plan] : []).slice(0, MAX_ASSESSED_PLANS);
    if (candidates.length === 0) throw new Error('Account is not liquidatable');
    const fees = this.feeReads(updates);
    const assessed: { plan: LiquidationPlan; assessment: LiquidationAssessment }[] = [];
    const unpriced: { plan: LiquidationPlan; assessment: LiquidationAssessment }[] = [];
    let firstError: unknown;
    for (const plan of candidates) {
      try {
        assessed.push({ plan, assessment: await this.assessPlan(protocol, plan, prices, updates, fees) });
      } catch (err) {
        // A pair that cannot be priced right now (e.g. its spoke RPC is down) must not keep the others from competing.
        firstError ??= err;
        unpriced.push({ plan, assessment: unpricedAssessment(plan, err) });
      }
    }
    if (assessed.length === 0) throw firstError;
    const held = (a: LiquidationAssessment) => (a.sale === 'hold' ? 1 : 0);
    const worth = assessed.filter((a) => a.assessment.action === 'liquidate');
    worth.sort((a, b) => held(a.assessment) - held(b.assessment) || b.assessment.netProfitUsd - a.assessment.netProfitUsd);
    return worth[0] ?? [...assessed].sort((a, b) => b.assessment.netProfitUsd - a.assessment.netProfitUsd)[0];
  }

  /**
   * Decides whether a plan (the account's best by default) is worth sending once its realisation is priced: seized
   * BTC is worth what Tigris pays for it, and so are pTokens of another asset than the debt once redeemed (pMEZO
   * against MUSD debt is worth the MUSD its MEZO sells for, not its oracle value); pTokens of the debt asset redeem at
   * par; spoke collateral is taken at a haircut and costs the spoke gas to relay its release. Gas, the oracle update
   * fee and the Wormhole fee are subtracted. A seizure the DEX would not buy back for the repayment is held
   * (LIQUIDATE_UNSELLABLE=hold) or skipped.
   */
  async assess(protocol: ProtocolState, e: AccountEvaluation, prices: UsdPrices, updates: Hex[], plan = e.plan): Promise<LiquidationAssessment> {
    if (!plan) throw new Error('Account is not liquidatable');
    return this.assessPlan(protocol, plan, prices, updates, this.feeReads(updates));
  }

  private async assessPlan(protocol: ProtocolState, plan: LiquidationPlan, prices: UsdPrices, updates: Hex[], fees: FeeReads): Promise<LiquidationAssessment> {
    const market = protocol.markets[plan.marketId];
    const coll = protocol.collaterals[plan.collateralId];
    const minProfit = this.ctx.config.minProfitUsd;
    const route = realisation(protocol, coll, market);
    const pair = { marketId: plan.marketId, collateralId: plan.collateralId };
    const spoke = plan.isRemote ? this.ctx.spokes.find((s) => s.deployment.wormholeChainId === coll.chainId) : undefined;
    if (plan.isRemote && !spoke) {
      return {
        ...pair,
        action: 'skip',
        sale: null,
        oracleProfitUsd: plan.profitUsd,
        netProfitUsd: 0,
        costsUsd: 0,
        saleQuote: null,
        reason: `seized ${coll.symbol} is released on wormhole chain ${coll.chainId}, which this agent has no spoke for: it could not relay the release`,
      };
    }
    const costsUsd = await this.costsUsd(plan, route, updates, prices, fees, spoke);
    const oracleNet = plan.profitUsd - costsUsd;
    const base = { ...pair, oracleProfitUsd: plan.profitUsd, costsUsd };
    if (route.kind === 'remote' || route.kind === 'redeem') {
      const haircutUsd = route.kind === 'remote' ? (plan.seizeUsd * REMOTE_REALISATION_HAIRCUT_BPS) / BPS : 0;
      const net = oracleNet - haircutUsd;
      const how =
        route.kind === 'remote'
          ? `at oracle prices less ${REMOTE_REALISATION_HAIRCUT_BPS / 100}% to realise it on the spoke`
          : `at par (${coll.symbol} redeems for ${market.symbol})`;
      return net >= minProfit
        ? { ...base, action: 'liquidate', sale: null, netProfitUsd: net, saleQuote: null, reason: `profitable ${how}, net of gas and fees` }
        : { ...base, action: 'skip', sale: null, netProfitUsd: net, saleQuote: null, reason: `net profit $${net.toFixed(2)} ${how} is below MIN_PROFIT_USD` };
    }
    // Sold on Tigris: BTC as seized; a pToken of another asset than the debt once redeemed for its pool's asset.
    const sold =
      route.kind === 'sell'
        ? {
            token: coll.token,
            decimals: coll.decimals,
            amount: plan.expectedSeize,
            what: `the seized ${coll.symbol}`,
            pair: `${coll.symbol} → ${market.symbol}`,
          }
        : {
            token: route.pool.asset,
            decimals: route.pool.decimals,
            amount: sharesToAssets(route.pool, plan.expectedSeize),
            what: `the ${route.pool.symbol} redeemed from the seized ${coll.symbol}`,
            pair: `${route.pool.symbol} → ${market.symbol}`,
          };
    const debtPrice = priceOf(prices, market.priceKey);
    const quote = await quoteTigris(this.ctx.hub, sold.token, market.asset, sold.amount).catch(() => null);
    const saleQuote = quote === null ? null : formatUnits(quote, market.decimals);
    const realised =
      quote === null ? null : toNumber((quote * BigInt(BPS - SLIPPAGE_BPS)) / BigInt(BPS) - plan.repayAmount, market.decimals) * debtPrice - costsUsd;
    const valued = { priceKey: coll.priceKey, decimals: sold.decimals };
    if (realised !== null && realised >= minProfit && this.withinOracleBound(quote!, sold.amount, valued, market, prices)) {
      return { ...base, action: 'liquidate', sale: 'sell', netProfitUsd: realised, saleQuote, reason: `profitable after selling ${sold.what} on Tigris` };
    }
    const why =
      quote === null
        ? `no Tigris quote for ${sold.pair}`
        : `Tigris pays ${saleQuote} ${market.symbol} for ${sold.what} (net $${realised!.toFixed(2)} after repaying ${formatUnits(plan.repayAmount, market.decimals)})`;
    if (this.ctx.config.unsellablePolicy === 'hold' && oracleNet >= minProfit) {
      return {
        ...base,
        action: 'liquidate',
        sale: 'hold',
        netProfitUsd: oracleNet,
        saleQuote,
        reason: `${why}: liquidating and holding it until a sale covers the repayment`,
      };
    }
    return { ...base, action: 'skip', sale: null, netProfitUsd: realised ?? oracleNet, saleQuote, reason: `${why}: below MIN_PROFIT_USD` };
  }

  private feeReads(updates: Hex[]): FeeReads {
    const { client, deployment } = this.ctx.hub;
    const spokeGas = new Map<string, Promise<bigint>>();
    return {
      hubGasPrice: once(() => client.getGasPrice()),
      oracleFee: once(() =>
        updates.length > 0
          ? client.readContract({ address: deployment.contracts.oracleRouter, abi: oracleRouterAbi, functionName: 'updateFee', args: [updates] })
          : Promise.resolve(0n),
      ),
      messageFee: once(() => client.readContract({ address: deployment.contracts.wormholeAdapter, abi: wormholeAdapterAbi, functionName: 'messageFee' })),
      spokeGasPrice: (spoke) => {
        let p = spokeGas.get(spoke.network);
        if (!p) spokeGas.set(spoke.network, (p = spoke.client.getGasPrice()));
        return p;
      },
    };
  }

  /**
   * Gas for the liquidation and the conversion that follows, the native fees it pays, and for spoke collateral the
   * spoke gas the keeper pays to relay the release that pays it out (VaultManager releases it to the keeper), in USD.
   */
  private async costsUsd(
    plan: LiquidationPlan,
    route: Realisation,
    updates: Hex[],
    prices: UsdPrices,
    fees: FeeReads,
    spoke: SpokeContext | undefined,
  ): Promise<number> {
    const [gasPrice, oracleFee, wormholeFee] = await Promise.all([
      fees.hubGasPrice(),
      fees.oracleFee(),
      plan.isRemote ? fees.messageFee() : Promise.resolve(0n),
    ]);
    let gas = updates.some(isSupraUpdate) ? GAS_FLOOR.supraProof : GAS_FLOOR.liquidation;
    if (route.kind === 'sell') gas += GAS_FLOOR.erc20Approve + GAS_FLOOR.dexSwap;
    if (route.kind === 'redeem') gas += GAS_FLOOR.poolRedeem;
    if (route.kind === 'redeem-sell') gas += GAS_FLOOR.poolRedeem + GAS_FLOOR.erc20Approve + GAS_FLOOR.dexSwap;
    const hub = NETWORKS[this.ctx.hub.network].chain.nativeCurrency;
    let usd = toNumber(gas * gasPrice + oracleFee + wormholeFee, hub.decimals) * (await this.nativeUsd(hub.symbol, prices));
    if (spoke) {
      const native = NETWORKS[spoke.network].chain.nativeCurrency;
      usd += toNumber(GAS_FLOOR.vaaRelay * (await fees.spokeGasPrice(spoke)), native.decimals) * (await this.nativeUsd(native.symbol, prices));
    }
    return usd;
  }

  /** USD price of a native coin: the usable one, else the router's last stored value (good enough for a gas estimate). */
  private async nativeUsd(symbol: string, prices: UsdPrices): Promise<number> {
    if (!(PRICE_SYMBOLS as readonly string[]).includes(symbol)) return 0;
    const s = symbol as PriceSymbol;
    if (prices[s] !== undefined) return prices[s];
    try {
      return displayPrices(await this.relay.oracle())[s] ?? 0;
    } catch {
      return 0;
    }
  }

  /** Oracle value of `amount` units of an asset (its price key and decimals) in debt-asset units (0 without both prices). */
  private oracleValue(amount: bigint, asset: { priceKey: Hex; decimals: number }, market: MarketState, prices: UsdPrices): bigint {
    const assetPrice = priceOf(prices, asset.priceKey);
    const debtPrice = priceOf(prices, market.priceKey);
    if (!(assetPrice > 0 && debtPrice > 0)) return 0n;
    const value = toNumber(amount, asset.decimals) * (assetPrice / debtPrice);
    return BigInt(Math.floor(value * 10 ** market.decimals));
  }

  /** The least a sale may return: MAX_SALE_DISCOUNT_BPS below the oracle value (0 without prices). */
  private oracleFloor(amount: bigint, asset: { priceKey: Hex; decimals: number }, market: MarketState, prices: UsdPrices): bigint {
    return (this.oracleValue(amount, asset, market, prices) * BigInt(BPS - this.ctx.config.maxSaleDiscountBps)) / BigInt(BPS);
  }

  private withinOracleBound(quote: bigint, amount: bigint, asset: { priceKey: Hex; decimals: number }, market: MarketState, prices: UsdPrices) {
    const floor = this.oracleFloor(amount, asset, market, prices);
    return floor > 0n && quote >= floor;
  }

  /**
   * Units of each token (lowercased address) the held lots account for, leaving out lot `except`: whatever the
   * keeper holds beyond them is its own (repay inventory, gas), never sold or redeemed as seized collateral.
   */
  private earmarked(protocol: ProtocolState, except?: string): Map<string, bigint> {
    const out = new Map<string, bigint>();
    const add = (token: Address, units: bigint) => out.set(token.toLowerCase(), (out.get(token.toLowerCase()) ?? 0n) + units);
    for (const [k, lot] of Object.entries(this.store.get().held ?? {})) {
      const coll = protocol.collaterals[lot.collateralId];
      if (k === except || !coll) continue;
      add(coll.token, lot.amount);
      const pool = lot.redeemed ? protocol.markets.find((m) => sameAddress(m.pool, coll.token)) : undefined;
      if (lot.redeemed && pool) add(pool.asset, lot.redeemed.amount);
    }
    return out;
  }

  /** Repay inventory per market: the keeper's balance of its asset less what held lots still have to sell of it. */
  private async inventory(protocol: ProtocolState): Promise<Record<number, bigint>> {
    const wallet = this.ctx.hub.wallet;
    if (!wallet) return {};
    const earmarked = this.earmarked(protocol);
    const entries = await Promise.all(
      protocol.markets.map(async (m) => {
        const balance = await this.ctx.hub.client.readContract({ address: m.asset, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account.address] });
        const held = earmarked.get(m.asset.toLowerCase()) ?? 0n;
        return [m.id, balance > held ? balance - held : 0n] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async tick(): Promise<void> {
    // Transactions sent before a restart, or that a send gave up on, are settled before anything is valued.
    await this.settlePending().catch((err: unknown) => this.ctx.log('liquidator', 'settling sent transactions failed', { error: publicError(err) }));
    const { protocol, evaluations, positions, prices, inventory } = await this.evaluateAll();
    const tick: LiquidatorTick = { at: Date.now(), evaluated: evaluations.length, liquidatable: 0, liquidated: 0, skipped: {} };
    const skip = (e: AccountEvaluation, reason: string, detail: Record<string, unknown> = {}) => {
      tick.skipped[reason] = (tick.skipped[reason] ?? 0) + 1;
      this.report(e.account, reason, detail);
    };
    this.lastAssessments.clear();
    const keeper = this.ctx.hub.wallet !== null;
    // Inventory left this tick: every plan was sized against the full balance, so later ones are re-planned.
    const remaining: Record<number, bigint> = { ...inventory };
    // Highest expected protocol loss first: inventory may run out before the queue does.
    for (const evaluated of evaluations.filter((x) => x.healthFactor < 1).sort(byShortfall)) {
      tick.liquidatable += 1;
      let e = evaluated;
      const short = (e.candidates ?? []).some((c) => remaining[c.marketId] !== undefined && remaining[c.marketId] < c.repayAmount);
      if (keeper && short) {
        const p = positions.find((x) => sameAddress(x.account, e.account));
        if (p) e = evaluateAccount(protocol, p, prices, remaining);
      }
      if (e.unpriced.length > 0) {
        skip(e, 'unpriced', { unpriced: e.unpriced });
        continue;
      }
      if (!e.plan) {
        if (keeper) skip(e, 'no repay inventory', { inventory: this.lastInventory });
        else skip(e, 'read-only');
        continue;
      }
      if (!keeper) {
        skip(e, 'read-only');
        continue;
      }
      try {
        const updates = await this.updatesFor(e);
        const { plan, assessment } = await this.choose(protocol, e, prices, updates);
        this.lastAssessments.set(e.account.toLowerCase(), assessment);
        if (assessment.action === 'skip') {
          skip(e, 'unprofitable', { reason: assessment.reason });
          continue;
        }
        const done = await this.execute(protocol, e, updates, false, { assessment, prices, plan });
        tick.liquidated += 1;
        if (remaining[plan.marketId] !== undefined) remaining[plan.marketId] -= minBig(remaining[plan.marketId], done.repaid ?? plan.repayAmount);
        this.reported.delete(e.account.toLowerCase());
      } catch (err) {
        skip(e, 'failed', { error: publicError(err) });
      }
    }
    for (const e of evaluations) if (!(e.healthFactor < 1)) this.reported.delete(e.account.toLowerCase());
    this.lastTick = tick;
    await this.convertHeld(protocol, prices).catch((err: unknown) =>
      this.ctx.log('liquidator', 'converting held collateral failed', { error: publicError(err) }),
    );
  }

  /** Logs a skipped liquidatable account once per change of reason (details such as quotes move every tick). */
  private report(account: Address, reason: string, detail: Record<string, unknown>): void {
    const key = account.toLowerCase();
    if (this.reported.get(key) === reason) return;
    this.reported.set(key, reason);
    this.ctx.log('liquidator', `liquidatable account skipped: ${reason}`, { account, ...detail });
  }

  /** The hub sender, only in the process that writes the state the liquidator's transactions change. */
  private sender(): TxSender {
    if (this.store.readOnly) throw new Error(READ_ONLY_SENDS);
    const sender = this.ctx.hub.sender;
    if (!sender) throw new Error('KEEPER_PRIVATE_KEY is not configured');
    return sender;
  }

  /**
   * Simulates and sends a liquidation of `opts.plan` (the account's best plan by default). Returns the transaction
   * hash (null when dry-run) and what the receipt's Liquidated event says was repaid and seized.
   */
  async execute(
    protocol: ProtocolState,
    e: AccountEvaluation,
    updates: Hex[],
    dryRun = false,
    opts: { assessment?: LiquidationAssessment; prices?: UsdPrices; plan?: LiquidationPlan } = {},
  ): Promise<{ simulated: bigint; txHash: Hex | null; seized: bigint | null; repaid: bigint | null }> {
    const plan = opts.plan ?? e.plan;
    if (!plan) throw new Error('Account is not liquidatable');
    const { client, wallet, deployment } = this.ctx.hub;
    if (!wallet) throw new Error('KEEPER_PRIVATE_KEY is not configured');
    const sender = dryRun ? null : this.sender();
    const key = e.account.toLowerCase();
    if (this.liquidating.has(key)) throw new Error(`A liquidation of ${e.account} is already in flight`);
    this.liquidating.add(key);
    try {
      const market = protocol.markets[plan.marketId];
      const gateway = deployment.contracts.keeperGateway;

      const allowance = await client.readContract({ address: market.asset, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, gateway] });
      if (allowance < plan.repayAmount && sender) {
        const approve = await sender.send(
          { address: market.asset, abi: erc20Abi, functionName: 'approve', args: [gateway, maxUint256] },
          { kind: 'approve', floor: GAS_FLOOR.erc20Approve },
        );
        if (approve.receipt.status !== 'success') throw new Error(`approve ${approve.hash} reverted`);
      }
      const oracleFee = await client.readContract({
        address: deployment.contracts.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'updateFee',
        args: [updates],
      });
      // Remote collateral is released on its spoke by a Wormhole message, which VaultManager pays for.
      const wormholeFee = plan.isRemote
        ? await client.readContract({ address: deployment.contracts.wormholeAdapter, abi: wormholeAdapterAbi, functionName: 'messageFee' })
        : 0n;
      const fee = oracleFee + wormholeFee;
      const { result, request } = await client.simulateContract({
        account: wallet.account,
        address: gateway,
        abi: keeperGatewayAbi,
        functionName: 'triggerLiquidation',
        args: [
          e.account,
          BigInt(plan.marketId),
          plan.repayAmount,
          BigInt(plan.collateralId),
          plan.minSeize,
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          updates,
        ],
        value: fee,
      });
      if (!sender) return { simulated: result, txHash: null, seized: null, repaid: null };
      const floor = updates.some(isSupraUpdate) ? GAS_FLOOR.supraProof : GAS_FLOOR.liquidation;
      const action: PendingAction = {
        type: 'liquidation',
        account: e.account,
        marketId: plan.marketId,
        collateralId: plan.collateralId,
        sale: opts.assessment?.sale ?? null,
        remote: plan.isRemote,
      };
      const { sent, applied: event } = await this.sendRecorded(sender, action, request, { kind: 'liquidation', floor }, (id, s) =>
        this.applyLiquidation(id, action, s),
      );
      const txHash = sent.hash;
      if (sent.receipt.status !== 'success') throw new Error(`liquidation transaction ${txHash} reverted`);
      // The receipt is the truth (the simulation ran at an earlier block, before interest accrued), and only a receipt
      // with the Liquidated event is a liquidation: anything else seized nothing.
      if (!event) throw new Error(`liquidation transaction ${txHash} has no Liquidated event for ${e.account}: nothing was seized`);
      this.ctx.log('liquidator', 'liquidated', {
        account: e.account,
        txHash,
        repaid: String(event.repaid),
        seized: String(event.seized),
        profitUsd: (opts.assessment?.netProfitUsd ?? plan.profitUsd).toFixed(2),
        remote: plan.isRemote,
      });
      // Seized hub collateral goes back into repay inventory: pTokens of the debt asset are redeemed, BTC is sold on
      // Tigris, pTokens of another asset are redeemed and what they pay out is sold. Remote collateral arrives on its spoke.
      if (!plan.isRemote && opts.assessment?.sale !== 'hold')
        await this.convertHeld(protocol, opts.prices ?? this.lastPrices, heldKey(plan.collateralId, plan.marketId));
      return { simulated: result, txHash, seized: event.seized, repaid: event.repaid };
    } finally {
      this.liquidating.delete(key);
    }
  }

  /**
   * Sends a transaction recorded in the state file before it leaves (see PendingTx) and applies its receipt with
   * `apply` as soon as send() returns it. A failure that may have reached the chain keeps the record for
   * settlePending; one that did not drops it.
   */
  private async sendRecorded<T>(
    sender: TxSender,
    action: PendingAction,
    request: object,
    options: SendOptions,
    apply: (id: string, sent: Sent) => T,
  ): Promise<{ sent: Sent; applied: T }> {
    const id = `${action.type}-${Date.now()}-${++this.recordSeq}`;
    const record = (tx: BroadcastTx) =>
      this.store.update((s) => {
        s.pending[id] = { action, nonce: tx.nonce, hashes: tx.hashes, sentAt: s.pending[id]?.sentAt ?? Date.now() };
      });
    this.sending.add(id);
    try {
      let sent: Sent;
      try {
        sent = await sender.send(request, { ...options, onBroadcast: record });
      } catch (err) {
        if (!(err instanceof SentTransactionError)) this.store.update((s) => void delete s.pending[id]);
        throw err;
      }
      return { sent, applied: apply(id, sent) };
    } finally {
      this.sending.delete(id);
    }
  }

  /** Records what a mined liquidation seized (a lot to convert, unless it is paid on a spoke) and drops its record. */
  private applyLiquidation(id: string, action: Extract<PendingAction, { type: 'liquidation' }>, sent: Pick<Sent, 'hash' | 'receipt'>) {
    const event = sent.receipt.status === 'success' ? liquidatedEvent(sent.receipt, this.ctx.hub.deployment.contracts.vaultManager, action.account) : null;
    this.store.update((s) => {
      delete s.pending[id];
      if (!event || action.remote || event.seized === 0n) return;
      const k = heldKey(action.collateralId, action.marketId);
      const cur = s.held[k];
      const minProceeds = action.sale === 'hold' ? event.repaid : 0n;
      s.held[k] = cur
        ? { ...cur, amount: cur.amount + event.seized, cost: cur.cost + event.repaid, minProceeds: cur.minProceeds + minProceeds, lastTx: sent.hash }
        : {
            collateralId: action.collateralId,
            marketId: action.marketId,
            amount: event.seized,
            cost: event.repaid,
            minProceeds,
            since: Date.now(),
            lastTx: sent.hash,
          };
    });
    return event;
  }

  /** Takes what a mined redeem burnt off its lot: released (debt asset) or moved to the lot's `redeemed` part. */
  private applyRedeem(id: string, action: Extract<PendingAction, { type: 'redeem' }>, sent: Pick<Sent, 'hash' | 'receipt'>, keeper: Address) {
    const paid =
      sent.receipt.status === 'success' ? (withdrawEvent(sent.receipt, action.pool, keeper) ?? { shares: action.shares, assets: action.expectedAssets }) : null;
    this.store.update((s) => {
      delete s.pending[id];
      const lot = s.held[action.lot];
      if (!paid || !lot) return;
      const { taken, left } = takeFrom({ amount: lot.amount, cost: lot.cost, minProceeds: lot.minProceeds }, paid.shares);
      Object.assign(lot, left ?? { amount: 0n, cost: 0n, minProceeds: 0n });
      if (action.sell && paid.assets > 0n) {
        const r = lot.redeemed ?? { amount: 0n, cost: 0n, minProceeds: 0n };
        lot.redeemed = { amount: r.amount + paid.assets, cost: r.cost + taken.cost, minProceeds: r.minProceeds + taken.minProceeds };
      }
      if (lot.amount === 0n && !lot.redeemed) delete s.held[action.lot];
    });
    this.reported.delete(`held:${action.lot}`);
    return paid;
  }

  /** Takes what a mined sale sold off its lot's part; returns the part sold and what the sale paid. */
  private applySwap(id: string, action: Extract<PendingAction, { type: 'swap' }>, sent: Pick<Sent, 'hash' | 'receipt'>, keeper: Address) {
    const out: { sold: HeldPart | null; proceeds: bigint } = { sold: null, proceeds: 0n };
    if (sent.receipt.status === 'success') out.proceeds = received(sent.receipt, action.proceedsToken, keeper);
    this.store.update((s) => {
      delete s.pending[id];
      const lot = s.held[action.lot];
      if (sent.receipt.status !== 'success' || !lot) return;
      if (action.stage === 'seized') {
        const { taken, left } = takeFrom({ amount: lot.amount, cost: lot.cost, minProceeds: lot.minProceeds }, action.amount);
        Object.assign(lot, left ?? { amount: 0n, cost: 0n, minProceeds: 0n });
        out.sold = taken;
      } else if (lot.redeemed) {
        const { taken, left } = takeFrom(lot.redeemed, action.amount);
        if (left) lot.redeemed = left;
        else delete lot.redeemed;
        out.sold = taken;
      }
      if (lot.amount === 0n && !lot.redeemed) delete s.held[action.lot];
    });
    this.reported.delete(`held:${action.lot}`);
    return out;
  }

  /** Runs `work` after every earlier settlement or conversion (they share the lots). */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.conversion.then(work);
    this.conversion = run.catch(() => undefined);
    return run;
  }

  /** Settles recorded transactions (see settleNow), after any conversion in flight. */
  settlePending(): Promise<void> {
    return this.serial(() => this.settleNow());
  }

  /**
   * Settles every recorded transaction whose send is not in flight here (one sent before a restart, or that a send
   * gave up on) from chain state: a receipt of one of its own transactions applies it; another transaction holding
   * its nonce for DROP_CONFIRM_MS means it never happened; otherwise it waits for the next tick.
   */
  private async settleNow(): Promise<void> {
    const sender = this.ctx.hub.sender;
    if (!sender || this.store.readOnly) return;
    for (const [id, p] of Object.entries(this.store.get().pending ?? {})) {
      if (this.sending.has(id)) continue;
      let settled: Awaited<ReturnType<TxSender['settle']>>;
      try {
        settled = await sender.settle(p.nonce, p.hashes);
      } catch (err) {
        this.note(`pending:${id}`, 'a recorded transaction could not be settled yet; retrying next tick', { id, error: publicError(err) });
        continue;
      }
      if (settled.status === 'pending') {
        if (p.droppedAt !== undefined) this.store.update((s) => void (s.pending[id] && delete s.pending[id].droppedAt));
        continue;
      }
      if (settled.status === 'dropped') {
        const now = Date.now();
        if (p.droppedAt === undefined) this.store.update((s) => void (s.pending[id] && (s.pending[id].droppedAt = now)));
        else if (now - p.droppedAt >= DROP_CONFIRM_MS) {
          this.store.update((s) => void delete s.pending[id]);
          this.ctx.log('liquidator', `a recorded ${p.action.type} never happened: another transaction holds its nonce`, {
            id,
            nonce: p.nonce,
            hashes: p.hashes,
          });
        }
        continue;
      }
      const sent = { hash: settled.receipt.transactionHash, receipt: settled.receipt };
      const a = p.action;
      const detail: Record<string, unknown> = { id, txHash: sent.hash, status: sent.receipt.status };
      if (a.type === 'liquidation') {
        const event = this.applyLiquidation(id, a, sent);
        Object.assign(detail, { account: a.account, seized: event ? String(event.seized) : null, repaid: event ? String(event.repaid) : null });
      } else if (a.type === 'redeem') {
        const paid = this.applyRedeem(id, a, sent, sender.address);
        Object.assign(detail, { lot: a.lot, shares: paid ? String(paid.shares) : null, assets: paid ? String(paid.assets) : null });
      } else {
        const { sold, proceeds } = this.applySwap(id, a, sent, sender.address);
        Object.assign(detail, { lot: a.lot, sold: sold ? String(sold.amount) : null, received: String(proceeds) });
      }
      this.reported.delete(`pending:${id}`);
      this.ctx.log('liquidator', `settled a ${a.type} sent earlier`, detail);
    }
  }

  /**
   * Converts held collateral back into debt assets (every tick, and right after a liquidation): pTokens are
   * redeemed as far as the pool's idle cash allows (and, for pTokens of another asset than the debt, what they pay out
   * is sold), plain collateral is sold on Tigris when the sale clears its oracle bound (and, for collateral held by
   * policy, returns at least what was repaid). A lot with a conversion still unsettled is left alone.
   */
  convertHeld(protocol: ProtocolState, prices: UsdPrices, only?: string): Promise<void> {
    return this.serial(async () => {
      await this.settleNow();
      for (const [k, lot] of Object.entries(this.store.get().held ?? {})) {
        if (only !== undefined && k !== only) continue;
        const coll = protocol.collaterals[lot.collateralId];
        const market = protocol.markets[lot.marketId];
        if (!coll || !market) continue;
        if (Object.values(this.store.get().pending ?? {}).some((p) => 'lot' in p.action && p.action.lot === k)) {
          this.note(k, `seized ${coll.symbol} kept: a conversion sent earlier is not settled yet`, {});
          continue;
        }
        try {
          const route = realisation(protocol, coll, market);
          if (route.kind === 'redeem' || route.kind === 'redeem-sell') await this.redeemHeld(protocol, k, coll, route.kind === 'redeem-sell');
          if (route.kind === 'redeem-sell') await this.sellHeld(protocol, k, 'redeemed', coll, market, prices);
          if (route.kind === 'sell') await this.sellHeld(protocol, k, 'seized', coll, market, prices);
        } catch (err) {
          this.note(k, `converting seized ${coll.symbol} failed (kept)`, { error: publicError(err) });
        }
      }
    });
  }

  /**
   * What lot `k` may convert of `token` now: the keeper's balance less what the other lots account for and, for
   * Mezo's BTC, twice the gas minimum. The lots size every conversion; a balance above them is the keeper's own.
   */
  private async spendable(protocol: ProtocolState, k: string, token: Address): Promise<bigint> {
    const { client } = this.ctx.hub;
    const keeper = this.ctx.hub.sender!.address;
    let balance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [keeper] });
    if (sameAddress(token, MEZO_BTC)) {
      // Never sell the keeper's gas: keep twice the low-balance threshold.
      const reserve = 2n * (this.ctx.config.minGasBalance?.[this.ctx.hub.network] ?? 0n);
      const native = await client.getBalance({ address: keeper });
      balance = minBig(balance, native > reserve ? native - reserve : 0n);
    }
    const others = this.earmarked(protocol, k).get(token.toLowerCase()) ?? 0n;
    return balance > others ? balance - others : 0n;
  }

  private async redeemHeld(protocol: ProtocolState, k: string, coll: CollateralState, sell: boolean): Promise<void> {
    const lot = this.store.get().held[k];
    const { client, sender } = this.ctx.hub;
    if (!lot || lot.amount === 0n || !sender || this.store.readOnly) return;
    const keeper = sender.address;
    const [maxRedeem, free] = await Promise.all([
      client.readContract({ address: coll.token, abi: pTokenAbi, functionName: 'maxRedeem', args: [keeper] }),
      this.spendable(protocol, k, coll.token),
    ]);
    const shares = minBig(lot.amount, maxRedeem, free);
    if (shares === 0n) {
      const why = free === 0n ? 'the keeper holds none of the shares this lot records' : 'the pool has no idle cash to redeem it yet';
      this.note(k, `seized ${coll.symbol} kept: ${why}`, { shares: String(lot.amount) });
      return;
    }
    const pool = protocol.markets.find((m) => sameAddress(m.pool, coll.token));
    const expectedAssets = pool ? sharesToAssets(pool, shares) : 0n;
    const action: PendingAction = { type: 'redeem', lot: k, pool: coll.token, shares, sell, expectedAssets };
    const { sent, applied } = await this.sendRecorded(
      sender,
      action,
      { address: coll.token, abi: pTokenAbi, functionName: 'redeem', args: [shares, keeper, keeper] },
      { kind: 'redeem', floor: GAS_FLOOR.poolRedeem },
      (id, s) => this.applyRedeem(id, action, s, keeper),
    );
    if (sent.receipt.status !== 'success') throw new Error(`redeem ${sent.hash} reverted`);
    this.ctx.log('liquidator', `redeemed seized ${coll.symbol}`, {
      shares: String(applied?.shares ?? shares),
      assets: String(applied?.assets ?? 0n),
      left: String(this.store.get().held[k]?.amount ?? 0n),
      txHash: sent.hash,
    });
  }

  /**
   * Sells one part of lot `k` on Tigris for the debt asset: the seized units (BTC) or what its pTokens redeemed into
   * (MEZO from pMEZO seized against MUSD debt), never below the oracle bound nor, pro rata, the part's minimum proceeds.
   */
  private async sellHeld(
    protocol: ProtocolState,
    k: string,
    stage: 'seized' | 'redeemed',
    coll: CollateralState,
    market: MarketState,
    prices: UsdPrices,
  ): Promise<void> {
    const { client, sender, deployment } = this.ctx.hub;
    const router = deployment.contracts.tigrisRouter;
    const factory = deployment.contracts.tigrisFactory;
    const lot = this.store.get().held[k];
    if (!lot || !sender || !router || !factory || this.store.readOnly) return;
    const pool = stage === 'redeemed' ? protocol.markets.find((m) => sameAddress(m.pool, coll.token)) : undefined;
    const part: HeldPart | undefined = stage === 'seized' ? { amount: lot.amount, cost: lot.cost, minProceeds: lot.minProceeds } : lot.redeemed;
    if (!part || part.amount === 0n || (stage === 'redeemed' && !pool)) return;
    // What is sold: the collateral token itself, or the asset its pool redeemed into (priced like the collateral).
    const sold = pool
      ? { token: pool.asset, decimals: pool.decimals, symbol: pool.symbol }
      : { token: coll.token, decimals: coll.decimals, symbol: coll.symbol };
    const keeper = sender.address;
    const amount = minBig(part.amount, await this.spendable(protocol, k, sold.token));
    if (amount <= 0n) return;
    const floor = this.oracleFloor(amount, { priceKey: coll.priceKey, decimals: sold.decimals }, market, prices);
    if (floor === 0n) {
      this.note(k, `seized ${coll.symbol} kept: no oracle price to bound the sale`, {});
      return;
    }
    const quote = await quoteTigris(this.ctx.hub, sold.token, market.asset, amount);
    const proceedsFloor = (part.minProceeds * amount) / part.amount;
    const minOut = maxBig((quote * BigInt(BPS - SLIPPAGE_BPS)) / BigInt(BPS), floor, proceedsFloor);
    if (quote < minOut) {
      this.note(k, `seized ${coll.symbol} kept: Tigris pays too little`, {
        amount: formatUnits(amount, sold.decimals),
        quote: formatUnits(quote, market.decimals),
        needs: formatUnits(minOut, market.decimals),
      });
      return;
    }
    const routes = [{ from: sold.token, to: market.asset, stable: false, factory }] as const;
    const allowance = await client.readContract({ address: sold.token, abi: erc20Abi, functionName: 'allowance', args: [keeper, router] });
    if (allowance < amount) {
      const approve = await sender.send(
        { address: sold.token, abi: erc20Abi, functionName: 'approve', args: [router, amount] },
        { kind: 'approve', floor: GAS_FLOOR.erc20Approve },
      );
      if (approve.receipt.status !== 'success') throw new Error(`approve ${approve.hash} reverted`);
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + SALE_DEADLINE_SEC);
    const action: PendingAction = { type: 'swap', lot: k, stage, amount, proceedsToken: market.asset };
    const { sent, applied } = await this.sendRecorded(
      sender,
      action,
      { address: router, abi: tigrisRouterAbi, functionName: 'swapExactTokensForTokens', args: [amount, minOut, routes, keeper, deadline] },
      { kind: 'swap', floor: GAS_FLOOR.dexSwap },
      (id, s) => this.applySwap(id, action, s, keeper),
    );
    if (sent.receipt.status !== 'success') throw new Error(`swap ${sent.hash} reverted`);
    const cost = applied.sold?.cost ?? (part.cost * amount) / part.amount;
    const debtPrice = priceOf(prices, market.priceKey);
    this.ctx.log('liquidator', `sold seized ${coll.symbol}${pool ? ` (redeemed ${sold.symbol})` : ''}`, {
      sold: formatUnits(amount, sold.decimals),
      received: formatUnits(applied.proceeds, market.decimals),
      cost: formatUnits(cost, market.decimals),
      realizedPnlUsd: (toNumber(applied.proceeds - cost, market.decimals) * debtPrice).toFixed(2),
      txHash: sent.hash,
    });
  }

  /** Logs a held-collateral state once per change of message. */
  private note(k: string, message: string, detail: Record<string, unknown>): void {
    const key = k.startsWith('pending:') ? k : `held:${k}`;
    if (this.reported.get(key) === message) return;
    this.reported.set(key, message);
    this.ctx.log('liquidator', message, detail);
  }
}
