import { join } from 'node:path';
import { erc20Abi, maxUint256, type Address, type Hex } from 'viem';
import {
  CLOSE_FACTOR_BPS,
  BPS,
  fetchPriceUpdate,
  keeperGatewayAbi,
  oracleRouterAbi,
  readPosition,
  readProtocol,
  pricesBySymbol,
  valuePosition,
  type UsdPrices,
  vaultManagerAbi,
  wormholeAdapterAbi,
  blockRanges,
  NETWORKS,
  type PositionState,
  type ProtocolState,
} from '@mezodot/sdk';
import type { Context } from './context';
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
  plan: LiquidationPlan | null;
};

const SLIPPAGE_BPS = 200;
const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

/**
 * Values a position with fresh off-chain prices and, if HF < 1, picks the largest debt and the
 * largest collateral, repaying up to the 50% close factor (capped by keeper inventory).
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

  const base = {
    account: position.account,
    healthFactor: summary.healthFactor,
    collateralUsd: summary.collateralUsd,
    remoteCollateralUsd: summary.remoteCollateralUsd,
    borrowLimitUsd: summary.borrowLimitUsd,
    adjustedUsd: summary.adjustedCollateralUsd,
    debtUsd: summary.debtUsd,
  };
  if (!(summary.healthFactor < 1)) return { ...base, plan: null };

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

  constructor(
    private readonly ctx: Context,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new JsonStore<LiquidatorState>(join(ctx.config.stateDir, `liquidator-${ctx.config.env}.json`), { cursor: null, accounts: [] });
  }

  async freshPrices() {
    const feeds = this.ctx.hub.deployment.priceFeeds;
    const update = await fetchPriceUpdate(NETWORKS[this.ctx.hub.network].hermesUrl, Object.values(feeds), this.fetchImpl);
    const prices = pricesBySymbol(feeds, update.prices);
    return { update, prices };
  }

  /**
   * Indexes borrowers from VaultManager.Borrowed in chunks below the RPC block-range cap, persisting
   * the cursor after every chunk so a restart (or a long outage) resumes instead of failing forever.
   */
  async syncAccounts(): Promise<Address[]> {
    const { client, deployment } = this.ctx.hub;
    const latest = await client.getBlockNumber();
    const from = this.store.get().cursor ?? BigInt(deployment.startBlock);
    for (const range of blockRanges(from, latest)) {
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

  async evaluateAll(): Promise<{
    protocol: ProtocolState;
    evaluations: AccountEvaluation[];
    update: Awaited<ReturnType<Liquidator['freshPrices']>>['update'];
  }> {
    const { client, deployment } = this.ctx.hub;
    const [accounts, protocol, { update, prices }] = await Promise.all([this.syncAccounts(), readProtocol(client, deployment), this.freshPrices()]);
    const inventory = await this.inventory(protocol);
    const evaluations = await Promise.all(
      accounts.map(async (a) => evaluateAccount(protocol, await readPosition(client, deployment, protocol, a), prices, inventory)),
    );
    this.lastEvaluations = evaluations;
    this.lastRun = Date.now();
    return { protocol, evaluations, update };
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
    const { protocol, evaluations, update } = await this.evaluateAll();
    for (const e of evaluations) {
      if (!e.plan || e.plan.profitUsd < this.ctx.config.minProfitUsd) continue;
      await this.execute(protocol, e, update.updates).catch((err: unknown) =>
        this.ctx.log('liquidator', 'liquidation failed', { account: e.account, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }),
      );
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
    await client.waitForTransactionReceipt({ hash: txHash });
    this.ctx.log('liquidator', 'liquidated', { account: e.account, txHash, profitUsd: plan.profitUsd.toFixed(2), remote: plan.isRemote });
    return { simulated: result, txHash };
  }
}
