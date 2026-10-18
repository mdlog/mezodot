import { join } from 'node:path';
import { erc20Abi, formatUnits, maxUint256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import {
  CLOSE_FACTOR_BPS,
  BPS,
  GAS_FLOOR,
  PRICE_SYMBOLS,
  SOURCE_TAG,
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
  type OracleState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '@mezodot/sdk';
import type { Context } from './context';
import { quoteTigris } from './dex';
import { publicError } from './errors';
import { settleLimited } from './net';
import { OracleRelay, relayCanServe } from './oracle/relay';
import { LogWindow } from './scan';
import { JsonStore, appendArchive, sameAddress } from './store';

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
  plan: LiquidationPlan | null;
};

/** Whether and how a planned liquidation goes ahead once realisation, gas and fees are counted. */
export type LiquidationAssessment = {
  action: 'liquidate' | 'skip';
  /** Seized plain hub collateral (BTC): sold on Tigris right away, or held until a sale covers the repayment. */
  sale: 'sell' | 'hold' | null;
  /** The plan's oracle-valued profit. */
  oracleProfitUsd: number;
  /** Profit at the price the keeper can realise (Tigris for plain collateral), net of gas and fees. */
  netProfitUsd: number;
  /** Gas (liquidation and conversion), oracle update fee and Wormhole fee, in USD. */
  costsUsd: number;
  /** Tigris quote for selling the expected seizure, in debt-asset units (plain hub collateral only). */
  saleQuote: string | null;
  reason: string;
};

/** Seized hub collateral not yet converted back into a debt asset (persisted: survives restarts). */
export type HeldCollateral = {
  collateralId: number;
  marketId: number;
  /** Units still held (shares for pTokens). */
  amount: bigint;
  /** Debt-asset units repaid to acquire them. */
  cost: bigint;
  /** Least debt-asset units a sale of the whole amount must return (the cost, for collateral held by policy). */
  minProceeds: bigint;
  since: number;
  lastTx: Hex;
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
/**
 * Seized spoke collateral (WETH/USDC) is paid out on its spoke, where the keeper still has to swap or bridge it
 * back into a debt asset: its realisable value is taken this much (bps) below the oracle value.
 */
export const REMOTE_REALISATION_HAIRCUT_BPS = 100;

const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
const minBig = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const maxBig = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a));
const priceOf = (prices: UsdPrices, key: Hex): number => {
  const s = symbolForPriceKey(key);
  return s ? (prices[s] ?? 0) : 0;
};
const isSupraUpdate = (u: Hex) => u.slice(0, 4).toLowerCase() === `0x${SOURCE_TAG.SUPRA.toString(16).padStart(2, '0')}`;
const heldKey = (collateralId: number, marketId: number) => `${collateralId}:${marketId}`;

/**
 * Values a position with the prices VaultManager would accept (see OracleRelay.pricing) and, if HF < 1,
 * picks the most profitable (debt, collateral) pair, repaying up to the 50% close factor (capped by
 * keeper inventory). Without a price for every held asset there is no plan: VaultManager prices
 * liquidations strictly and would revert.
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
  if (!(summary.healthFactor < 1) || unpriced.length > 0) return { ...base, plan: null };

  // Try every (debt market, collateral) pair; bonuses differ per collateral and the scaled branch
  // caps what a small collateral can pay, so the largest collateral is not always the best.
  let best: LiquidationPlan | null = null;
  for (const debt of debtRows) {
    if (debt.amount === 0n || debt.price <= 0) continue;
    for (const coll of collateralRows) {
      if (coll.balance === 0n || coll.price <= 0) continue;
      const plan = planPair(debt, coll, inventory[debt.m.id], protocol.liquidationFeeBps);
      if (!plan) continue;
      const better = !best || plan.profitUsd > best.profitUsd + 1e-9 || (Math.abs(plan.profitUsd - best.profitUsd) <= 1e-9 && best.isRemote && !plan.isRemote);
      if (better) best = plan;
    }
  }
  return { ...base, plan: best };
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
};

/** One evaluation of every indexed borrower. */
export type Evaluation = {
  protocol: ProtocolState;
  evaluations: AccountEvaluation[];
  positions: PositionState[];
  oracle: OracleState;
  prices: UsdPrices;
  /** Keeper wallet balance of each market's asset (by market id) when the evaluation ran. */
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

/** The Liquidated event VaultManager emitted in `receipt` (what was actually repaid and seized). */
export function liquidatedEvent(receipt: Pick<TransactionReceipt, 'logs'>, vaultManager: Address): { repaid: bigint; seized: bigint } | null {
  const logs = parseEventLogs({ abi: vaultManagerAbi, eventName: 'Liquidated', logs: receipt.logs ?? [] });
  const log = logs.find((l) => sameAddress(l.address, vaultManager));
  return log ? { repaid: log.args.repaid, seized: log.args.seized } : null;
}

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
  private conversion: Promise<unknown> = Promise.resolve();
  private readonly archivePath: string;

  constructor(
    private readonly ctx: Context,
    readonly relay: OracleRelay = new OracleRelay(ctx),
  ) {
    this.store = new JsonStore<LiquidatorState>(
      join(ctx.config.stateDir, `liquidator-${ctx.config.env}.json`),
      { vaultManager: null, cursor: null, accounts: [], held: {} },
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

  /** Held collateral in whole units, for /health and /metrics. */
  heldSummary(): { collateral: string; market: string; amount: string; cost: string; minProceeds: string; since: number }[] {
    const p = this.lastProtocol;
    return this.held().map((h) => {
      const c = p?.collaterals[h.collateralId];
      const m = p?.markets[h.marketId];
      const shareDecimals = c?.isShare ? p?.markets.find((x) => sameAddress(x.pool, c.token))?.shareDecimals : undefined;
      return {
        collateral: c?.symbol ?? `#${h.collateralId}`,
        market: m?.symbol ?? `#${h.marketId}`,
        amount: formatUnits(h.amount, shareDecimals ?? c?.decimals ?? 18),
        cost: formatUnits(h.cost, m?.decimals ?? 18),
        minProceeds: formatUnits(h.minProceeds, m?.decimals ?? 18),
        since: h.since,
      };
    });
  }

  /** Whether the last evaluation is recent enough to answer from (MCP tools). */
  isFresh(maxAgeMs: number, now = Date.now()): boolean {
    return this.lastRun !== null && now - this.lastRun <= maxAgeMs;
  }

  /**
   * A state file written for another VaultManager (a redeploy, or a file older than deployment identities) is not
   * resumed: the index restarts at the current deployment's start block. The old borrowers, cursor and held
   * collateral go to the archive file, so the old deployment's open debt stays visible.
   */
  private reconcileDeployment(): void {
    const vm = this.ctx.hub.deployment.contracts.vaultManager;
    const s = this.store.get();
    s.held ??= {};
    if (sameAddress(s.vaultManager, vm)) return;
    // Borrowers and held collateral of the old contracts still need someone to look at them: keep them on file.
    const hadState = s.accounts.length > 0 || Object.keys(s.held).length > 0;
    if (hadState && !this.store.readOnly) {
      appendArchive(this.archivePath, {
        archivedAt: new Date().toISOString(),
        reason: 'deployment replaced',
        vaultManager: s.vaultManager,
        cursor: s.cursor,
        accounts: s.accounts,
        held: s.held,
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
   * Decides whether a plan is worth sending once its realisation is priced: seized plain collateral (BTC) is
   * worth what Tigris pays for it, not the oracle price; seized spoke collateral is taken at a haircut (it still has
   * to be swapped or bridged back); pTokens redeem at par. Gas, the oracle update fee and the Wormhole fee are
   * subtracted. A plain-collateral liquidation the DEX would not pay back is held (LIQUIDATE_UNSELLABLE=hold) or
   * skipped.
   */
  async assess(protocol: ProtocolState, e: AccountEvaluation, prices: UsdPrices, updates: Hex[]): Promise<LiquidationAssessment> {
    const plan = e.plan;
    if (!plan) throw new Error('Account is not liquidatable');
    const market = protocol.markets[plan.marketId];
    const coll = protocol.collaterals[plan.collateralId];
    const minProfit = this.ctx.config.minProfitUsd;
    const plain = !coll.isShare && !coll.isRemote;
    const costsUsd = await this.costsUsd(plan, updates, prices, plain ? 'sale' : coll.isShare ? 'redeem' : 'none');
    const oracleNet = plan.profitUsd - costsUsd;
    const base = { oracleProfitUsd: plan.profitUsd, costsUsd };
    if (!plain) {
      const haircutUsd = coll.isRemote ? (plan.seizeUsd * REMOTE_REALISATION_HAIRCUT_BPS) / BPS : 0;
      const net = oracleNet - haircutUsd;
      const how = coll.isRemote
        ? `at oracle prices less ${REMOTE_REALISATION_HAIRCUT_BPS / 100}% to realise it on the spoke`
        : 'at par (pTokens redeem for the debt asset)';
      return net >= minProfit
        ? { ...base, action: 'liquidate', sale: null, netProfitUsd: net, saleQuote: null, reason: `profitable ${how}, net of gas and fees` }
        : { ...base, action: 'skip', sale: null, netProfitUsd: net, saleQuote: null, reason: `net profit $${net.toFixed(2)} ${how} is below MIN_PROFIT_USD` };
    }
    // Plain hub collateral (BTC): the debt asset only comes back by selling the seizure on Tigris.
    const debtPrice = priceOf(prices, market.priceKey);
    const quote = await quoteTigris(this.ctx.hub, coll.token, market.asset, plan.expectedSeize).catch(() => null);
    const saleQuote = quote === null ? null : formatUnits(quote, market.decimals);
    const realised =
      quote === null ? null : toNumber((quote * BigInt(BPS - SLIPPAGE_BPS)) / BigInt(BPS) - plan.repayAmount, market.decimals) * debtPrice - costsUsd;
    if (realised !== null && realised >= minProfit && this.withinOracleBound(quote!, plan.expectedSeize, coll, market, prices)) {
      return {
        ...base,
        action: 'liquidate',
        sale: 'sell',
        netProfitUsd: realised,
        saleQuote,
        reason: `profitable after selling the seized ${coll.symbol} on Tigris`,
      };
    }
    const why =
      quote === null
        ? `no Tigris quote for ${coll.symbol} → ${market.symbol}`
        : `Tigris pays ${saleQuote} ${market.symbol} for the seized ${coll.symbol} (net $${realised!.toFixed(2)} after repaying ${formatUnits(plan.repayAmount, market.decimals)})`;
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

  /** Gas for the liquidation and the conversion that follows, plus the native fees it pays, in USD. */
  private async costsUsd(plan: LiquidationPlan, updates: Hex[], prices: UsdPrices, conversion: 'sale' | 'redeem' | 'none'): Promise<number> {
    const { client, deployment, network } = this.ctx.hub;
    const [gasPrice, oracleFee, wormholeFee] = await Promise.all([
      client.getGasPrice(),
      updates.length > 0
        ? client.readContract({ address: deployment.contracts.oracleRouter, abi: oracleRouterAbi, functionName: 'updateFee', args: [updates] })
        : Promise.resolve(0n),
      plan.isRemote
        ? client.readContract({ address: deployment.contracts.wormholeAdapter, abi: wormholeAdapterAbi, functionName: 'messageFee' })
        : Promise.resolve(0n),
    ]);
    let gas = updates.some(isSupraUpdate) ? GAS_FLOOR.supraProof : GAS_FLOOR.liquidation;
    if (conversion === 'sale') gas += GAS_FLOOR.erc20Approve + GAS_FLOOR.dexSwap;
    if (conversion === 'redeem') gas += GAS_FLOOR.poolRedeem;
    const native = NETWORKS[network].chain.nativeCurrency;
    const nativeUsd = (PRICE_SYMBOLS as readonly string[]).includes(native.symbol) ? (prices[native.symbol as PriceSymbol] ?? 0) : 0;
    return toNumber(gas * gasPrice + oracleFee + wormholeFee, native.decimals) * nativeUsd;
  }

  /** Oracle value of `amount` collateral units in debt-asset units (0 without both prices). */
  private oracleValue(amount: bigint, coll: ProtocolState['collaterals'][number], market: ProtocolState['markets'][number], prices: UsdPrices): bigint {
    const collPrice = priceOf(prices, coll.priceKey);
    const debtPrice = priceOf(prices, market.priceKey);
    if (!(collPrice > 0 && debtPrice > 0)) return 0n;
    const value = toNumber(amount, coll.decimals) * (collPrice / debtPrice);
    return BigInt(Math.floor(value * 10 ** market.decimals));
  }

  /** The least a sale may return: MAX_SALE_DISCOUNT_BPS below the oracle value (0 without prices). */
  private oracleFloor(amount: bigint, coll: ProtocolState['collaterals'][number], market: ProtocolState['markets'][number], prices: UsdPrices): bigint {
    return (this.oracleValue(amount, coll, market, prices) * BigInt(BPS - this.ctx.config.maxSaleDiscountBps)) / BigInt(BPS);
  }

  private withinOracleBound(
    quote: bigint,
    amount: bigint,
    coll: ProtocolState['collaterals'][number],
    market: ProtocolState['markets'][number],
    prices: UsdPrices,
  ) {
    const floor = this.oracleFloor(amount, coll, market, prices);
    return floor > 0n && quote >= floor;
  }

  private async inventory(protocol: ProtocolState): Promise<Record<number, bigint>> {
    const wallet = this.ctx.hub.wallet;
    if (!wallet) return {};
    const entries = await Promise.all(
      protocol.markets.map(
        async (m) =>
          [
            m.id,
            await this.ctx.hub.client.readContract({ address: m.asset, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account.address] }),
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async tick(): Promise<void> {
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
      const left = e.plan ? remaining[e.plan.marketId] : undefined;
      if (keeper && e.plan && left !== undefined && left < e.plan.repayAmount) {
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
        const assessment = await this.assess(protocol, e, prices, updates);
        this.lastAssessments.set(e.account.toLowerCase(), assessment);
        if (assessment.action === 'skip') {
          skip(e, 'unprofitable', { reason: assessment.reason });
          continue;
        }
        const done = await this.execute(protocol, e, updates, false, { assessment, prices });
        tick.liquidated += 1;
        if (remaining[e.plan.marketId] !== undefined) remaining[e.plan.marketId] -= minBig(remaining[e.plan.marketId], done.repaid ?? e.plan.repayAmount);
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

  /** Simulates and sends a liquidation. Returns the transaction hash (null when dry-run) and what was seized. */
  async execute(
    protocol: ProtocolState,
    e: AccountEvaluation,
    updates: Hex[],
    dryRun = false,
    opts: { assessment?: LiquidationAssessment; prices?: UsdPrices } = {},
  ): Promise<{ simulated: bigint; txHash: Hex | null; seized: bigint | null; repaid: bigint | null }> {
    const plan = e.plan;
    if (!plan) throw new Error('Account is not liquidatable');
    const { client, wallet, sender, deployment } = this.ctx.hub;
    if (!wallet || !sender) throw new Error('KEEPER_PRIVATE_KEY is not configured');
    const key = e.account.toLowerCase();
    if (this.liquidating.has(key)) throw new Error(`A liquidation of ${e.account} is already in flight`);
    this.liquidating.add(key);
    try {
      const market = protocol.markets[plan.marketId];
      const gateway = deployment.contracts.keeperGateway;

      const allowance = await client.readContract({ address: market.asset, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, gateway] });
      if (allowance < plan.repayAmount && !dryRun) {
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
      if (dryRun) return { simulated: result, txHash: null, seized: null, repaid: null };
      const floor = updates.some(isSupraUpdate) ? GAS_FLOOR.supraProof : GAS_FLOOR.liquidation;
      const { hash: txHash, receipt } = await sender.send(request, { kind: 'liquidation', floor });
      if (receipt.status !== 'success') throw new Error(`liquidation transaction ${txHash} reverted`);
      // The receipt is the truth: the simulation ran at an earlier block, before interest accrued.
      const event = liquidatedEvent(receipt, deployment.contracts.vaultManager);
      const seized = event?.seized ?? result;
      const repaid = event?.repaid ?? plan.repayAmount;
      this.ctx.log('liquidator', 'liquidated', {
        account: e.account,
        txHash,
        repaid: String(repaid),
        seized: String(seized),
        profitUsd: (opts.assessment?.netProfitUsd ?? plan.profitUsd).toFixed(2),
        remote: plan.isRemote,
      });
      // Seized hub collateral goes back into repay inventory: pTokens are redeemed (pMUSD → MUSD, pMEZO → MEZO),
      // plain collateral (BTC) is sold for the debt asset on Tigris. Remote collateral arrives on its spoke.
      const coll = protocol.collaterals[plan.collateralId];
      if (!coll.isRemote) {
        const held = opts.assessment?.sale === 'hold';
        this.hold({ collateralId: plan.collateralId, marketId: plan.marketId, amount: seized, cost: repaid, minProceeds: held ? repaid : 0n, txHash });
        if (!held) await this.convertHeld(protocol, opts.prices ?? this.lastPrices, heldKey(plan.collateralId, plan.marketId));
      }
      return { simulated: result, txHash, seized, repaid };
    } finally {
      this.liquidating.delete(key);
    }
  }

  private hold(lot: { collateralId: number; marketId: number; amount: bigint; cost: bigint; minProceeds: bigint; txHash: Hex }): void {
    if (lot.amount === 0n) return;
    const k = heldKey(lot.collateralId, lot.marketId);
    this.store.update((s) => {
      const cur = s.held[k];
      s.held[k] = cur
        ? { ...cur, amount: cur.amount + lot.amount, cost: cur.cost + lot.cost, minProceeds: cur.minProceeds + lot.minProceeds, lastTx: lot.txHash }
        : {
            collateralId: lot.collateralId,
            marketId: lot.marketId,
            amount: lot.amount,
            cost: lot.cost,
            minProceeds: lot.minProceeds,
            since: Date.now(),
            lastTx: lot.txHash,
          };
    });
  }

  /** Takes `amount` (and its pro-rata cost) off a held lot after it was converted. */
  private release(k: string, amount: bigint): void {
    this.reported.delete(`held:${k}`);
    this.store.update((s) => {
      const lot = s.held[k];
      if (!lot) return;
      if (amount >= lot.amount) {
        delete s.held[k];
        return;
      }
      s.held[k] = {
        ...lot,
        amount: lot.amount - amount,
        cost: lot.cost - (lot.cost * amount) / lot.amount,
        minProceeds: lot.minProceeds - (lot.minProceeds * amount) / lot.amount,
      };
    });
  }

  /**
   * Converts held collateral back into debt assets (every tick, and right after a liquidation): pTokens are
   * redeemed as far as the pool's idle cash allows, plain collateral is sold on Tigris when the sale clears its
   * oracle bound (and, for collateral held by policy, returns at least what was repaid). One conversion at a time.
   */
  convertHeld(protocol: ProtocolState, prices: UsdPrices, only?: string): Promise<void> {
    const run = this.conversion.then(async () => {
      for (const [k, lot] of Object.entries(this.store.get().held ?? {})) {
        if (only !== undefined && k !== only) continue;
        const coll = protocol.collaterals[lot.collateralId];
        const market = protocol.markets[lot.marketId];
        if (!coll || !market) continue;
        try {
          if (coll.isShare) await this.redeemHeld(k, lot, coll);
          else await this.sellHeld(k, lot, coll, market, prices);
        } catch (err) {
          this.note(k, `converting seized ${coll.symbol} failed (kept)`, { error: publicError(err) });
        }
      }
    });
    this.conversion = run.catch(() => undefined);
    return run;
  }

  private async redeemHeld(k: string, lot: HeldCollateral, coll: ProtocolState['collaterals'][number]): Promise<void> {
    const { client, sender } = this.ctx.hub;
    if (!sender) return;
    const keeper = sender.address;
    const [maxRedeem, balance] = await Promise.all([
      client.readContract({ address: coll.token, abi: pTokenAbi, functionName: 'maxRedeem', args: [keeper] }),
      client.readContract({ address: coll.token, abi: pTokenAbi, functionName: 'balanceOf', args: [keeper] }),
    ]);
    const shares = minBig(lot.amount, maxRedeem, balance);
    if (shares === 0n) {
      this.note(k, `seized ${coll.symbol} kept: the pool has no idle cash to redeem it yet`, { shares: String(lot.amount) });
      return;
    }
    const { hash, receipt } = await sender.send(
      { address: coll.token, abi: pTokenAbi, functionName: 'redeem', args: [shares, keeper, keeper] },
      { kind: 'redeem', floor: GAS_FLOOR.poolRedeem },
    );
    if (receipt.status !== 'success') throw new Error(`redeem ${hash} reverted`);
    this.release(k, shares);
    this.ctx.log('liquidator', `redeemed seized ${coll.symbol}`, { shares: String(shares), left: String(lot.amount - shares), txHash: hash });
  }

  private async sellHeld(
    k: string,
    lot: HeldCollateral,
    coll: ProtocolState['collaterals'][number],
    market: ProtocolState['markets'][number],
    prices: UsdPrices,
  ): Promise<void> {
    const { client, sender, deployment } = this.ctx.hub;
    const router = deployment.contracts.tigrisRouter;
    const factory = deployment.contracts.tigrisFactory;
    if (!sender || !router || !factory) return;
    const keeper = sender.address;
    let amount = minBig(lot.amount, await client.readContract({ address: coll.token, abi: erc20Abi, functionName: 'balanceOf', args: [keeper] }));
    if (sameAddress(coll.token, MEZO_BTC)) {
      // Never sell the keeper's gas: keep twice the low-balance threshold.
      const reserve = 2n * (this.ctx.config.minGasBalance?.[this.ctx.hub.network] ?? 0n);
      const balance = await client.getBalance({ address: keeper });
      amount = minBig(amount, balance > reserve ? balance - reserve : 0n);
    }
    if (amount <= 0n) return;
    const floor = this.oracleFloor(amount, coll, market, prices);
    if (floor === 0n) {
      this.note(k, `seized ${coll.symbol} kept: no oracle price to bound the sale`, {});
      return;
    }
    const quote = await quoteTigris(this.ctx.hub, coll.token, market.asset, amount);
    const proceedsFloor = (lot.minProceeds * amount) / lot.amount;
    const minOut = maxBig((quote * BigInt(BPS - SLIPPAGE_BPS)) / BigInt(BPS), floor, proceedsFloor);
    if (quote < minOut) {
      this.note(k, `seized ${coll.symbol} kept: Tigris pays too little`, {
        amount: formatUnits(amount, coll.decimals),
        quote: formatUnits(quote, market.decimals),
        needs: formatUnits(minOut, market.decimals),
      });
      return;
    }
    const routes = [{ from: coll.token, to: market.asset, stable: false, factory }] as const;
    const allowance = await client.readContract({ address: coll.token, abi: erc20Abi, functionName: 'allowance', args: [keeper, router] });
    if (allowance < amount) {
      const approve = await sender.send(
        { address: coll.token, abi: erc20Abi, functionName: 'approve', args: [router, amount] },
        { kind: 'approve', floor: GAS_FLOOR.erc20Approve },
      );
      if (approve.receipt.status !== 'success') throw new Error(`approve ${approve.hash} reverted`);
    }
    const before = await client.readContract({ address: market.asset, abi: erc20Abi, functionName: 'balanceOf', args: [keeper] });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + SALE_DEADLINE_SEC);
    const { hash, receipt } = await sender.send(
      { address: router, abi: tigrisRouterAbi, functionName: 'swapExactTokensForTokens', args: [amount, minOut, routes, keeper, deadline] },
      { kind: 'swap', floor: GAS_FLOOR.dexSwap },
    );
    if (receipt.status !== 'success') throw new Error(`swap ${hash} reverted`);
    const after = await client.readContract({ address: market.asset, abi: erc20Abi, functionName: 'balanceOf', args: [keeper] });
    const received = after - before;
    const cost = (lot.cost * amount) / lot.amount;
    this.release(k, amount);
    const debtPrice = priceOf(prices, market.priceKey);
    this.ctx.log('liquidator', `sold seized ${coll.symbol}`, {
      sold: formatUnits(amount, coll.decimals),
      received: formatUnits(received, market.decimals),
      cost: formatUnits(cost, market.decimals),
      realizedPnlUsd: (toNumber(received - cost, market.decimals) * debtPrice).toFixed(2),
      txHash: hash,
    });
  }

  /** Logs a held-collateral state once per change of message. */
  private note(k: string, message: string, detail: Record<string, unknown>): void {
    if (this.reported.get(`held:${k}`) === message) return;
    this.reported.set(`held:${k}`, message);
    this.ctx.log('liquidator', message, detail);
  }
}
