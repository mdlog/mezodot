import { formatUnits, getAddress, isAddress, type Address } from 'viem';
import { perSecondToAnnual, planLoop, readPosition, readProtocol, symbolForPriceKey, type ProtocolState } from '@mezodot/sdk';
import { evaluateAccount } from '../liquidator';
import type { Services } from '../services';

/**
 * MCP tool handlers as plain async functions (the MCP server wires them up; tests call them
 * directly). Write tools default to dry-run and only execute with MCP_ALLOW_WRITE=true.
 */

const addr = (raw: string): Address => {
  if (!isAddress(raw)) throw new Error(`Invalid address: ${raw}`);
  return getAddress(raw);
};

export function describeMarkets(protocol: ProtocolState) {
  return protocol.markets.map((m) => {
    const util = m.totalAssets > 0n ? Number(m.totalBorrows) / Number(m.totalAssets) : 0;
    return {
      market: m.symbol,
      receipt: m.receiptSymbol,
      marketId: m.id,
      pool: m.pool,
      totalSupplied: formatUnits(m.totalAssets, m.decimals),
      totalBorrowed: formatUnits(m.totalBorrows, m.decimals),
      availableLiquidity: formatUnits(m.cash, m.decimals),
      utilization: util,
      borrowApy: perSecondToAnnual(m.borrowRatePerSecond),
      supplyApy: perSecondToAnnual(m.supplyRatePerSecond),
      exchangeRate: formatUnits(m.exchangeRate, m.decimals),
    };
  });
}

export function describeCollaterals(protocol: ProtocolState) {
  return protocol.collaterals.map((c) => ({
    collateralId: c.id,
    symbol: c.symbol,
    location: c.isRemote ? `spoke (wormhole chain ${c.chainId})` : 'hub',
    priceFeed: symbolForPriceKey(c.priceKey),
    ltv: c.ltvBps / 10_000,
    liquidationThreshold: c.ltBps / 10_000,
    liquidationBonus: c.bonusBps / 10_000,
    enabled: c.enabled,
  }));
}

export function createTools(s: Services) {
  const { ctx } = s;
  const protocol = () => readProtocol(ctx.hub.client, ctx.hub.deployment);

  return {
    async get_markets() {
      const p = await protocol();
      return { markets: describeMarkets(p), collaterals: describeCollaterals(p), keepers: p.keeperCount };
    },

    async get_position({ address }: { address: string }) {
      const account = addr(address);
      const [p, { prices }] = await Promise.all([protocol(), s.liquidator.freshPrices()]);
      const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
      const evaluation = evaluateAccount(p, position, prices);
      return {
        account,
        healthFactor: Number.isFinite(evaluation.healthFactor) ? evaluation.healthFactor : null,
        collateralUsd: evaluation.collateralUsd,
        debtUsd: evaluation.debtUsd,
        collateral: position.collateral
          .filter((c) => c.balance > 0n)
          .map((c) => ({ ...describeCollaterals(p)[c.id], balance: formatUnits(c.balance, p.collaterals[c.id].isRemote ? p.collaterals[c.id].decimals : 24) })),
        debts: position.debts
          .filter((d) => d.amount > 0n)
          .map((d) => ({ market: p.markets[d.marketId].symbol, amount: formatUnits(d.amount, p.markets[d.marketId].decimals) })),
        liquidation: evaluation.plan,
        pricesUsed: prices,
      };
    },

    async get_risk_report() {
      return s.risk.report() ?? (await s.risk.refresh()) ?? { error: s.risk.lastError() ?? 'Risk report not available yet' };
    },

    async simulate_loop({ principal, leverage }: { principal: number; leverage: number }) {
      const p = await protocol();
      const musd = p.markets.find((m) => m.symbol === 'MUSD');
      const collateral = p.collaterals.find((c) => c.symbol === 'pMUSD');
      if (!musd || !collateral) throw new Error('MUSD market not configured');
      return planLoop(principal, leverage, {
        ltvBps: collateral.ltvBps,
        ltBps: collateral.ltBps,
        supplyApy: perSecondToAnnual(musd.supplyRatePerSecond),
        borrowApy: perSecondToAnnual(musd.borrowRatePerSecond),
      });
    },

    async simulate_borrow({ address, market, amount }: { address: string; market: string; amount: number }) {
      const account = addr(address);
      const [p, { prices }] = await Promise.all([protocol(), s.liquidator.freshPrices()]);
      const m = p.markets.find((x) => x.symbol === market.toUpperCase());
      if (!m) throw new Error(`Unknown market ${market}`);
      const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
      const current = evaluateAccount(p, position, prices);
      const priceSymbol = symbolForPriceKey(m.priceKey);
      const addedUsd = amount * (priceSymbol ? (prices[priceSymbol] ?? 0) : 0);
      const debtAfterUsd = current.debtUsd + addedUsd;
      const healthFactorAfter = debtAfterUsd > 0 ? current.adjustedUsd / debtAfterUsd : null;
      return {
        allowed: debtAfterUsd <= current.borrowLimitUsd,
        healthFactorBefore: Number.isFinite(current.healthFactor) ? current.healthFactor : null,
        healthFactorAfter,
        borrowLimitUsd: current.borrowLimitUsd,
        debtAfterUsd,
      };
    },

    async list_liquidatable() {
      const { evaluations } = await s.liquidator.evaluateAll();
      return evaluations.filter((e) => e.plan).map((e) => ({ account: e.account, healthFactor: e.healthFactor, plan: e.plan }));
    },

    async list_pending_messages() {
      return s.relayer.pending().map(({ vaa: _vaa, ...m }) => m);
    },

    async trigger_liquidation({ address, dry_run = true }: { address: string; dry_run?: boolean }) {
      const account = addr(address);
      const { protocol: p, evaluations, update } = await s.liquidator.evaluateAll();
      const e =
        evaluations.find((x) => x.account.toLowerCase() === account.toLowerCase()) ??
        evaluateAccount(p, await readPosition(ctx.hub.client, ctx.hub.deployment, p, account), (await s.liquidator.freshPrices()).prices);
      if (!e.plan) return { executed: false, reason: 'Account is not liquidatable', healthFactor: e.healthFactor };
      const execute = !dry_run && ctx.config.mcpAllowWrite;
      if (!ctx.hub.wallet) return { executed: false, reason: 'No keeper key configured; returning plan only', plan: e.plan };
      const result = await s.liquidator.execute(p, e, update.updates, !execute);
      return {
        executed: execute,
        reason: execute ? 'sent' : dry_run ? 'dry run (pass dry_run=false to execute)' : 'writes disabled (set MCP_ALLOW_WRITE=true)',
        plan: e.plan,
        simulatedSeize: result.simulated,
        txHash: result.txHash,
      };
    },

    async relay_message({ id, dry_run = true }: { id: string; dry_run?: boolean }) {
      const m = s.relayer.messages().find((x) => x.id === id);
      if (!m) throw new Error(`Unknown message ${id}`);
      if (dry_run || !ctx.config.mcpAllowWrite) {
        const { vaa: _vaa, ...rest } = m;
        return { executed: false, reason: dry_run ? 'dry run' : 'writes disabled (set MCP_ALLOW_WRITE=true)', message: rest };
      }
      const { vaa: _vaa, ...after } = await s.relayer.relay(id);
      return { executed: true, message: after };
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
