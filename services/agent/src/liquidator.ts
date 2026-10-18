import { join } from 'node:path';
import { erc20Abi, formatUnits, maxUint256, type Address, type Hex } from 'viem';
import {
  CLOSE_FACTOR_BPS,
  BPS,
  PRICE_SYMBOLS,
  keeperGatewayAbi,
  NETWORKS,
  oracleRouterAbi,
  pTokenAbi,
  pricesAfterUpdate,
  readPosition,
  readProtocol,
  riskCheckSymbols,
  usablePrices,
  valuePosition,
  type UsdPrices,
  vaultManagerAbi,
  wormholeAdapterAbi,
  blockRanges,
  type OracleState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '@mezodot/sdk';
import type { Context } from './context';
import { OracleRelay, relayCanServe } from './oracle/relay';
import { JsonStore } from './store';

export type { UsdPrices };

export type LiquidationPlan = {
  marketId: number;
  collateralId: number;
  /** Debt tokens to repay (wei). */
  repayAmount: bigint;
  /** Minimum collateral units to accept (shares for local pTokens, token units for remote). */
  minSeize: bigint;
  repayUsd: number;
  seizeUsd: number;
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

const SLIPPAGE_BPS = 200;
const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
const errorLine = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0] : String(err));

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
      const plan = planPair(debt, coll, inventory[debt.m.id]);
      if (!plan) continue;
      const better = !best || plan.profitUsd > best.profitUsd + 1e-9 || (Math.abs(plan.profitUsd - best.profitUsd) <= 1e-9 && best.isRemote && !plan.isRemote);
      if (better) best = plan;
    }
  }
  return { ...base, plan: best };
}

type DebtRow = { m: ProtocolState['markets'][number]; amount: bigint; price: number; valueUsd: number };
type CollateralRow = { c: ProtocolState['collaterals'][number]; balance: bigint; units: number; price: number; valueUsd: number };

/** Mirrors VaultManager.liquidate/_seizeAmount for one pair: 50% close factor, bonus, scaled branch. */
function planPair(debt: DebtRow, coll: CollateralRow, available: bigint | undefined): LiquidationPlan | null {
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
  const seizeFraction = coll.valueUsd > 0 ? seizeUsd / coll.valueUsd : 0;
  const expectedSeize = BigInt(Math.floor(Number(coll.balance) * seizeFraction));
  const minSeize = (expectedSeize * BigInt(BPS - SLIPPAGE_BPS)) / BigInt(BPS);
  return {
    marketId: debt.m.id,
    collateralId: coll.c.id,
    repayAmount,
    minSeize,
    repayUsd,
    seizeUsd,
    profitUsd: seizeUsd - repayUsd,
    isRemote: coll.c.isRemote,
  };
}

type LiquidatorState = { cursor: bigint | null; accounts: Address[] };

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

/** Watches borrowers and liquidates unhealthy positions through KeeperGateway. */
export class Liquidator {
  readonly store: JsonStore<LiquidatorState>;
  lastEvaluations: AccountEvaluation[] = [];
  lastRun: number | null = null;
  /** Keeper wallet balances of each market's asset at the last tick (formatted), for /health. */
  lastInventory: Record<string, string> = {};
  /** Liquidatable accounts already reported as blocked by missing inventory (logged once each). */
  private readonly blocked = new Set<string>();

  constructor(
    private readonly ctx: Context,
    readonly relay: OracleRelay = new OracleRelay(ctx),
  ) {
    this.store = new JsonStore<LiquidatorState>(join(ctx.config.stateDir, `liquidator-${ctx.config.env}.json`), { cursor: null, accounts: [] });
  }

  /**
   * Indexes borrowers from VaultManager.Borrowed in chunks below the RPC block-range cap, persisting
   * the cursor after every chunk so a restart (or a long outage) resumes instead of failing forever.
   */
  async syncAccounts(): Promise<Address[]> {
    const { client, deployment } = this.ctx.hub;
    const latest = await client.getBlockNumber();
    const from = this.store.get().cursor ?? BigInt(deployment.startBlock);
    for (const range of blockRanges(from, latest, NETWORKS[this.ctx.hub.network].maxLogRange)) {
      const logs = await client.getContractEvents({
        address: deployment.contracts.vaultManager,
        abi: vaultManagerAbi,
        eventName: 'Borrowed',
        ...range,
      });
      this.store.update((s) => {
        s.accounts = mergeAccounts(
          s.accounts,
          logs.flatMap((l) => (l.args.account ? [l.args.account] : [])),
        );
        s.cursor = range.toBlock + 1n;
      });
    }
    return this.store.get().accounts;
  }

  /**
   * Values every indexed borrower. One failing position read skips that account for this tick instead
   * of aborting the whole tick; pull prices are fetched once for the union of symbols the accounts need.
   */
  async evaluateAll(): Promise<{ protocol: ProtocolState; evaluations: AccountEvaluation[]; oracle: OracleState }> {
    const { client, deployment } = this.ctx.hub;
    const [accounts, protocol] = await Promise.all([this.syncAccounts(), readProtocol(client, deployment)]);
    const [inventory, reads] = await Promise.all([
      this.inventory(protocol),
      Promise.allSettled(accounts.map((a) => readPosition(client, deployment, protocol, a))),
    ]);
    const positions: PositionState[] = [];
    reads.forEach((r, i) => {
      if (r.status === 'fulfilled') positions.push(r.value);
      else this.ctx.log('liquidator', 'position read failed', { account: accounts[i], error: errorLine(r.reason) });
    });
    const symbols = PRICE_SYMBOLS.filter((s) => positions.some((p) => riskCheckSymbols(protocol, p).includes(s)));
    const { oracle, prices } = await this.keeperPricing(symbols).catch(async (err: unknown) => {
      // Pull prices down (e.g. Supra unreachable): keep going with what the router already accepts.
      this.ctx.log('liquidator', 'pull prices unavailable', { error: errorLine(err) });
      const oracle = await this.relay.oracle();
      return { oracle, prices: usablePrices(oracle), updates: [] as Hex[] };
    });
    const evaluations = positions.map((p) => evaluateAccount(protocol, p, prices, inventory));
    const active = new Set(activeBorrowers(positions).map((a) => a.toLowerCase()));
    const repaid = new Set(positions.map((p) => p.account.toLowerCase()).filter((a) => !active.has(a)));
    if (repaid.size > 0) this.store.update((s) => void (s.accounts = s.accounts.filter((a) => !repaid.has(a.toLowerCase()))));
    this.lastInventory = Object.fromEntries(protocol.markets.map((m) => [m.symbol, formatUnits(inventory[m.id] ?? 0n, m.decimals)]));
    this.lastEvaluations = evaluations;
    this.lastRun = Date.now();
    return { protocol, evaluations, oracle };
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

  private async redeemSeized(pToken: Address, shares: bigint): Promise<void> {
    const { client, wallet } = this.ctx.hub;
    if (!wallet || shares === 0n) return;
    try {
      const hash = await wallet.writeContract({
        address: pToken,
        abi: pTokenAbi,
        functionName: 'redeem',
        args: [shares, wallet.account.address, wallet.account.address],
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`redeem ${hash} reverted`);
    } catch (err) {
      this.ctx.log('liquidator', 'redeeming seized collateral failed (kept as pTokens)', { pToken, shares: String(shares), error: errorLine(err) });
    }
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
    const { protocol, evaluations } = await this.evaluateAll();
    for (const e of evaluations) {
      // HF < 1 with every price available but no plan: the keeper holds none of the debt assets.
      const stuck = e.healthFactor < 1 && e.unpriced.length === 0 && !e.plan && this.ctx.hub.wallet !== null;
      if (stuck && !this.blocked.has(e.account)) {
        this.blocked.add(e.account);
        this.ctx.log('liquidator', 'liquidatable account skipped: no repay inventory', { account: e.account, inventory: this.lastInventory });
      } else if (!stuck) this.blocked.delete(e.account);
      if (!e.plan || e.plan.profitUsd < this.ctx.config.minProfitUsd) continue;
      await this.updatesFor(e)
        .then((updates) => this.execute(protocol, e, updates))
        .catch((err: unknown) => this.ctx.log('liquidator', 'liquidation failed', { account: e.account, error: errorLine(err) }));
    }
  }

  /** Simulates and sends a liquidation. Returns the transaction hash (or null when dry-run). */
  async execute(protocol: ProtocolState, e: AccountEvaluation, updates: Hex[], dryRun = false): Promise<{ simulated: bigint; txHash: Hex | null }> {
    const plan = e.plan;
    if (!plan) throw new Error('Account is not liquidatable');
    const { client, wallet, deployment } = this.ctx.hub;
    if (!wallet) throw new Error('KEEPER_PRIVATE_KEY is not configured');
    const market = protocol.markets[plan.marketId];
    const gateway = deployment.contracts.keeperGateway;

    const allowance = await client.readContract({ address: market.asset, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, gateway] });
    if (allowance < plan.repayAmount && !dryRun) {
      const tx = await wallet.writeContract({ address: market.asset, abi: erc20Abi, functionName: 'approve', args: [gateway, maxUint256] });
      await client.waitForTransactionReceipt({ hash: tx });
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
    if (dryRun) return { simulated: result, txHash: null };
    const txHash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`liquidation transaction ${txHash} reverted`);
    this.ctx.log('liquidator', 'liquidated', { account: e.account, txHash, profitUsd: plan.profitUsd.toFixed(2), remote: plan.isRemote });
    // Seized pTokens go back into the underlying, which is the repay inventory for the next liquidation
    // (pMUSD → MUSD, pMEZO → MEZO). Best effort: at full utilisation the pool may not have the cash yet.
    if (!plan.isRemote) await this.redeemSeized(protocol.collaterals[plan.collateralId].token, result);
    return { simulated: result, txHash };
  }
}
