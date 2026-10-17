import { formatUnits, getAddress, isAddress, type Address } from 'viem';
import {
  perSecondToAnnual,
  planLoop,
  positionSymbols,
  readPosition,
  readProtocol,
  riskCheckSymbols,
  symbolForPriceKey,
  type ProtocolState,
} from '@mezodot/sdk';
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

export type ToolOptions = {
  /** Whether write tools may execute (dry_run=false). Decided by the transport: see http.ts / stdio.ts. */
  allowWrite: boolean;
};

export function createTools(s: Services, opts: ToolOptions) {
  const { ctx } = s;
  const protocol = () => readProtocol(ctx.hub.client, ctx.hub.deployment);

  return {
    async get_markets() {
      const p = await protocol();
      return { markets: describeMarkets(p), collaterals: describeCollaterals(p), keepers: p.keeperCount };
    },

    async get_position({ address }: { address: string }) {
      const account = addr(address);
      const p = await protocol();
      const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
      // Price everything the account holds, as a transaction sent now would see it.
      const { prices, unpriced } = await s.oracle.pricing(positionSymbols(p, position));
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
        unpriced,
      };
    },

    async get_oracle_health() {
      return s.watchdog.report() ?? (await s.watchdog.check());
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
      const p = await protocol();
      const m = p.markets.find((x) => x.symbol === market.toUpperCase());
      if (!m) throw new Error(`Unknown market ${market}`);
      const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
      const priceSymbol = symbolForPriceKey(m.priceKey);
      const { prices, unpriced } = await s.oracle.pricing(riskCheckSymbols(p, position, priceSymbol));
      const current = evaluateAccount(p, position, prices);
      const debtPrice = priceSymbol ? prices[priceSymbol] : undefined;
      const addedUsd = amount * (debtPrice ?? 0);
      const debtAfterUsd = current.debtUsd + addedUsd;
      const healthFactorAfter = debtAfterUsd > 0 ? current.adjustedUsd / debtAfterUsd : null;
      // Debt is priced strictly: without a price for every debt asset the borrow reverts.
      const debtUnpriced = unpriced.filter((u) => u === priceSymbol || p.markets.some((x) => symbolForPriceKey(x.priceKey) === u));
      return {
        allowed: debtUnpriced.length === 0 && debtAfterUsd <= current.borrowLimitUsd,
        unpriced,
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

    async trigger_liquidation({ address, dry_run = true, force = false }: { address: string; dry_run?: boolean; force?: boolean }) {
      const account = addr(address);
      const { protocol: p, evaluations } = await s.liquidator.evaluateAll();
      let e = evaluations.find((x) => x.account.toLowerCase() === account.toLowerCase());
      if (!e) {
        const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
        e = evaluateAccount(p, position, (await s.oracle.pricing(riskCheckSymbols(p, position))).prices);
      }
      if (e.unpriced.length > 0) {
        return { executed: false, reason: `No acceptable price for ${e.unpriced.join(', ')}: a liquidation would revert`, healthFactor: e.healthFactor };
      }
      if (!e.plan) return { executed: false, reason: 'Account is not liquidatable', healthFactor: e.healthFactor };
      if (!force && e.plan.profitUsd < ctx.config.minProfitUsd) {
        return {
          executed: false,
          reason: `Expected profit $${e.plan.profitUsd.toFixed(2)} is below MIN_PROFIT_USD (pass force=true to override)`,
          plan: e.plan,
        };
      }
      const execute = !dry_run && opts.allowWrite;
      if (!ctx.hub.wallet) return { executed: false, reason: 'No keeper key configured; returning plan only', plan: e.plan };
      const result = await s.liquidator.execute(p, e, await s.liquidator.updatesFor(e), !execute);
      return {
        executed: execute,
        reason: execute ? 'sent' : dry_run ? 'dry run (pass dry_run=false to execute)' : 'writes disabled (MCP_ALLOW_WRITE=true, and MCP_TOKEN over HTTP)',
        plan: e.plan,
        simulatedSeize: result.simulated,
        txHash: result.txHash,
      };
    },

    async relay_message({ id, dry_run = true }: { id: string; dry_run?: boolean }) {
      const m = s.relayer.messages().find((x) => x.id === id);
      if (!m) throw new Error(`Unknown message ${id}`);
      if (dry_run || !opts.allowWrite) {
        const { vaa: _vaa, ...rest } = m;
        return { executed: false, reason: dry_run ? 'dry run' : 'writes disabled (MCP_ALLOW_WRITE=true, and MCP_TOKEN over HTTP)', message: rest };
      }
      const { vaa: _vaa, ...after } = await s.relayer.relay(id);
      return { executed: true, message: after };
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
