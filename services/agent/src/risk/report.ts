import { join } from 'node:path';
import {
  displayPrices,
  marketPoolState,
  maxLoopPrincipal,
  perSecondToApy,
  planLoop,
  PRICE_SYMBOLS,
  readProtocol,
  symbolForPriceKey,
  tigrisRouterAbi,
  type LoopTerms,
  type PriceSymbol,
  type ProtocolState,
  type UsdPrices,
} from '@mezodot/sdk';
import type { Context } from '../context';
import { publicError } from '../errors';
import type { OracleRelay } from '../oracle/relay';
import { JsonStore, sameAddress } from '../store';
import { annualize, historicalVaR, horizonReturns, maxDrawdown, simpleReturns, stdev, HOURS_PER_YEAR } from './stats';
import { walkForward } from './walkforward';

export type PriceHistory = { symbol: PriceSymbol; source: string; t: number[]; p: number[] };

export type AssetRisk = {
  symbol: PriceSymbol;
  collateral: string | null;
  source: string;
  points: number;
  from: number;
  to: number;
  lastPrice: number;
  vol30dAnnual: number;
  vol90dAnnual: number;
  maxDrawdown90d: number;
  var99_1h: number;
  var99_24h: number;
  /**
   * Discount at which seized collateral can be sold right now (Tigris quote for half the posted amount vs the
   * oracle price); 0 for collateral redeemable at par, null where no on-chain market is known.
   */
  liquidityHaircut: number | null;
  currentLtv: number | null;
  currentLt: number | null;
  /** LT × (1 − VaR99 over the liquidation horizon − liquidity haircut). */
  recommendedLtv: number | null;
  verdict: 'ok' | 'tighten' | 'n/a';
};

export type StrategyRisk = {
  collateral: PriceSymbol;
  description: string;
  grid: number[];
  windows: number;
  oosSharpeAnnual: number;
  deflatedSharpe: number;
  modalLeverage: number;
  robust: boolean;
};

/**
 * MUSD loop carry per leverage, priced at the state each loop leaves the pool in (its supply and debt share the
 * pool). `vsPlainSupply` is what the loop adds over supplying the same principal (negative: what it costs);
 * `feeCost` is the one-off 0.09% flash fee as a share of equity.
 */
export type LoopCarry = {
  leverage: number;
  /** Principal the row is priced at: LOOP_REFERENCE_PRINCIPAL, or less when the pool cannot fund that much. */
  principal: number;
  netApy: number;
  plainSupplyApy: number;
  vsPlainSupply: number;
  feeCost: number;
  /** Pool utilization after the loop (null when the rate model could not be read). */
  utilization: number | null;
  /** Why LeverageManager would refuse this loop now (liquidity, caps, LTV), if it would. */
  error: string | null;
}[];

export type RiskReport = {
  generatedAt: number;
  env: string;
  dsrThreshold: number;
  assets: AssetRisk[];
  strategies: StrategyRisk[];
  /** pMUSD → MUSD loop carry from live on-chain rates (base interest only, no incentives). */
  loopCarry: LoopCarry;
  rates: { musdBorrowApy: number; musdSupplyApy: number };
  notes: string[];
};

export const DSR_THRESHOLD = 0.95;
const LEVERAGE_GRID = [1.5, 2, 2.5, 3, 3.5, 4];
/** MUSD of equity each loop-carry row is priced at (capped by what the pool can fund). */
const LOOP_REFERENCE_PRINCIPAL = 1_000;
const COINGECKO_IDS: Record<PriceSymbol, string> = { ETH: 'ethereum', MEZO: 'mezo', MUSD: 'mezo-usd', USDC: 'usd-coin', BTC: 'bitcoin' };
/** Dollar-pegged assets: no leverage strategy to test. */
const STABLES: readonly PriceSymbol[] = ['MUSD', 'USDC'];
/**
 * Hours a position can sit between crossing the threshold and being liquidated and its collateral sold (keeper
 * latency, a stale pull price, a thin market): the VaR horizon for LTV advice.
 */
export const LIQUIDATION_HORIZON_HOURS = 24;
/** Pause between CoinGecko requests: its public API allows a few calls per minute. */
const COINGECKO_PAUSE_MS = 1_500;

/** Highest LTV whose buffer to the liquidation threshold survives a VaR99 move and a sale at a discount. */
export const recommendLtv = (lt: number, var99: number, liquidityHaircut = 0): number => Math.max(0, lt * (1 - var99 - liquidityHaircut));

const lastN = <T>(xs: T[], n: number) => xs.slice(Math.max(0, xs.length - n));

/**
 * @param liquidity Discount at which each collateral's seizure sells now (see AssetRisk.liquidityHaircut).
 */
export function buildReport(
  env: string,
  histories: PriceHistory[],
  protocol: ProtocolState | null,
  now = Date.now(),
  liquidity: Partial<Record<PriceSymbol, number>> = {},
): RiskReport {
  const notes: string[] = [
    `Recommended LTVs use a ${LIQUIDATION_HORIZON_HOURS} h VaR99 (the liquidation horizon) and, where a DEX quote exists, the discount at which seized collateral sells.`,
  ];
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const musdBorrowApy = musd ? perSecondToApy(musd.borrowRatePerSecond) : 0;
  const musdSupplyApy = musd ? perSecondToApy(musd.supplyRatePerSecond) : 0;
  if (!protocol) notes.push('On-chain parameters unavailable; LTV comparison skipped.');

  const assets: AssetRisk[] = histories.map((h) => {
    const r1h = simpleReturns(h.p);
    const collateral = protocol?.collaterals.find((c) => symbolForPriceKey(c.priceKey) === h.symbol) ?? null;
    const var1h = historicalVaR(r1h, 0.99);
    const varHorizon = historicalVaR(horizonReturns(h.p, LIQUIDATION_HORIZON_HOURS), 0.99);
    const haircut = collateral?.isShare ? 0 : (liquidity[h.symbol] ?? null);
    const currentLt = collateral ? collateral.ltBps / 10_000 : null;
    const currentLtv = collateral ? collateral.ltvBps / 10_000 : null;
    const recommendedLtv = currentLt !== null ? recommendLtv(currentLt, varHorizon, haircut ?? 0) : null;
    return {
      symbol: h.symbol,
      collateral: collateral?.symbol ?? null,
      source: h.source,
      points: h.p.length,
      from: h.t[0] ?? 0,
      to: h.t[h.t.length - 1] ?? 0,
      lastPrice: h.p[h.p.length - 1] ?? 0,
      vol30dAnnual: annualize(stdev(lastN(r1h, 24 * 30))),
      vol90dAnnual: annualize(stdev(r1h)),
      maxDrawdown90d: maxDrawdown(h.p),
      var99_1h: var1h,
      var99_24h: varHorizon,
      liquidityHaircut: haircut,
      currentLtv,
      currentLt,
      recommendedLtv,
      verdict: currentLtv === null || recommendedLtv === null ? 'n/a' : currentLtv <= recommendedLtv ? 'ok' : 'tighten',
    };
  });

  const strategies: StrategyRisk[] = [];
  for (const symbol of histories.map((x) => x.symbol).filter((x) => !STABLES.includes(x))) {
    const h = histories.find((x) => x.symbol === symbol);
    const collateral = protocol?.collaterals.find((c) => symbolForPriceKey(c.priceKey) === symbol);
    if (!h || h.p.length < 24 * 30) continue;
    const r = simpleReturns(h.p);
    const wf = walkForward(r, LEVERAGE_GRID, 24 * 14, 24 * 7, {
      borrowRatePerPeriod: musdBorrowApy / HOURS_PER_YEAR,
      liquidationThreshold: collateral ? collateral.ltBps / 10_000 : 0.8,
      liquidationBonus: collateral ? collateral.bonusBps / 10_000 : 0.07,
    });
    strategies.push({
      collateral: symbol,
      description: `Long ${symbol} collateral, MUSD debt, rebalanced hourly; 14d train / 7d test windows`,
      grid: LEVERAGE_GRID,
      windows: wf.windows.length,
      oosSharpeAnnual: wf.oosSharpe * Math.sqrt(HOURS_PER_YEAR),
      deflatedSharpe: wf.deflatedSharpe,
      modalLeverage: wf.modalLeverage,
      robust: wf.deflatedSharpe >= DSR_THRESHOLD,
    });
  }

  const pMusd = protocol?.collaterals.find((c) => c.symbol === 'pMUSD');
  const loopTerms: LoopTerms = {
    ltvBps: pMusd?.ltvBps ?? 8_000,
    ltBps: pMusd?.ltBps ?? 8_500,
    supplyApy: musdSupplyApy,
    borrowApy: musdBorrowApy,
    pool: musd ? (marketPoolState(musd) ?? undefined) : undefined,
  };
  const loopCarry: LoopCarry = LEVERAGE_GRID.map((leverage) => {
    const fundable = maxLoopPrincipal(leverage, loopTerms);
    // Below what the pool can fund the row reports the loop as it would be refused (error) at 1 MUSD.
    const principal = fundable > 0 ? Math.min(LOOP_REFERENCE_PRINCIPAL, fundable) : 1;
    const plan = planLoop(principal, leverage, loopTerms);
    return {
      leverage,
      principal,
      netApy: plan.netApy,
      plainSupplyApy: plan.plainSupplyApy,
      vsPlainSupply: plan.vsPlainSupply,
      feeCost: plan.feeCost,
      utilization: plan.utilization,
      error: plan.error,
    };
  });
  if (musd && musdBorrowApy > musdSupplyApy)
    notes.push(
      'MUSD loop carry is negative without external incentives: borrow APY exceeds supply APY by construction (supply = borrow × utilization × (1 − reserve factor)).',
    );

  return { generatedAt: now, env, dsrThreshold: DSR_THRESHOLD, assets, strategies, loopCarry, rates: { musdBorrowApy, musdSupplyApy }, notes };
}

/** Price symbols whose risk matters for the deployment: every collateral and every debt market. */
export function riskSymbols(protocol: ProtocolState | null): PriceSymbol[] {
  if (!protocol) return ['ETH', 'MEZO', 'MUSD', 'USDC', 'BTC'];
  const keys = [...protocol.collaterals.map((c) => c.priceKey), ...protocol.markets.map((m) => m.priceKey)];
  const wanted = new Set(keys.map(symbolForPriceKey).filter((s): s is PriceSymbol => s !== undefined));
  return PRICE_SYMBOLS.filter((s) => wanted.has(s));
}

/** 90 days of hourly prices from CoinGecko's public API. */
export async function fetchHistory(symbol: PriceSymbol, fetchImpl: typeof fetch = fetch): Promise<PriceHistory> {
  const res = await fetchImpl(`https://api.coingecko.com/api/v3/coins/${COINGECKO_IDS[symbol]}/market_chart?vs_currency=usd&days=90`);
  if (!res.ok) throw new Error(`CoinGecko ${symbol}: HTTP ${res.status}`);
  const body = (await res.json()) as { prices: [number, number][] };
  return { symbol, source: 'coingecko', t: body.prices.map((x) => x[0]), p: body.prices.map((x) => x[1]) };
}

/**
 * Periodically rebuilds the risk report; keeps the last good report when a source fails. One failing price
 * history only drops that asset (noted in the report).
 */
export class RiskEngine {
  private readonly store: JsonStore<{ report: RiskReport | null; error: string | null; vaultManager: string | null }>;

  constructor(
    private readonly ctx: Context,
    private readonly fetchImpl: typeof fetch = ctx.fetch ?? fetch,
    private readonly relay: OracleRelay | null = null,
    private readonly pauseMs = COINGECKO_PAUSE_MS,
  ) {
    this.store = new JsonStore(
      join(ctx.config.stateDir, `risk-${ctx.config.env}.json`),
      { report: null, error: null, vaultManager: null },
      { readOnly: ctx.config.stateReadOnly },
    );
    // A report computed for another deployment compares against parameters that no longer exist.
    if (!sameAddress(this.store.get().vaultManager, ctx.hub.deployment.contracts.vaultManager)) {
      this.store.update((s) => {
        s.report = null;
        s.error = null;
        s.vaultManager = ctx.hub.deployment.contracts.vaultManager;
      });
    }
  }

  report(): RiskReport | null {
    return this.store.get().report;
  }

  lastError(): string | null {
    return this.store.get().error;
  }

  async refresh(): Promise<RiskReport | null> {
    try {
      const protocol = await readProtocol(this.ctx.hub.client, this.ctx.hub.deployment).catch(() => null);
      const histories: PriceHistory[] = [];
      const failed: string[] = [];
      for (const s of riskSymbols(protocol)) {
        if (histories.length + failed.length > 0) await new Promise((r) => setTimeout(r, this.pauseMs));
        try {
          histories.push(await fetchHistory(s, this.fetchImpl));
        } catch (err) {
          failed.push(`${s} (${publicError(err)})`);
        }
      }
      if (histories.length === 0) throw new Error(`no price history available: ${failed.join('; ')}`);
      const liquidity = protocol ? await this.liquidityHaircuts(protocol).catch(() => ({})) : {};
      const report = buildReport(this.ctx.config.env, histories, protocol, Date.now(), liquidity);
      if (failed.length > 0) report.notes.push(`Price history unavailable for ${failed.join('; ')}; those assets are missing from this report.`);
      this.store.update((s) => {
        s.report = report;
        s.error = null;
      });
      this.ctx.log('risk', 'report refreshed', { assets: report.assets.length, strategies: report.strategies.length, ...(failed.length ? { failed } : {}) });
      return report;
    } catch (err) {
      const message = publicError(err);
      this.store.update((s) => {
        s.error = message;
      });
      this.ctx.log('risk', 'refresh failed', { error: message });
      return this.report();
    }
  }

  /**
   * Tigris discount to the oracle price for plain hub collateral: the quote for selling half of what is posted
   * (one close-factor liquidation of everything; at least 0.01 units) into the first debt market.
   */
  private async liquidityHaircuts(protocol: ProtocolState): Promise<Partial<Record<PriceSymbol, number>>> {
    const { client, deployment } = this.ctx.hub;
    const router = deployment.contracts.tigrisRouter;
    const factory = deployment.contracts.tigrisFactory;
    const market = protocol.markets[0];
    if (!router || !factory || !market || !this.relay) return {};
    const prices: UsdPrices = displayPrices(await this.relay.oracle());
    const debtSymbol = symbolForPriceKey(market.priceKey);
    const debtPrice = debtSymbol ? (prices[debtSymbol] ?? 0) : 0;
    const out: Partial<Record<PriceSymbol, number>> = {};
    for (const c of protocol.collaterals) {
      const symbol = symbolForPriceKey(c.priceKey);
      if (c.isShare || c.isRemote || !symbol || !(debtPrice > 0) || !((prices[symbol] ?? 0) > 0)) continue;
      const minimum = 10n ** BigInt(Math.max(0, c.decimals - 2));
      const amount = c.total / 2n > minimum ? c.total / 2n : minimum;
      const amounts = await client.readContract({
        address: router,
        abi: tigrisRouterAbi,
        functionName: 'getAmountsOut',
        args: [amount, [{ from: c.token, to: market.asset, stable: false, factory }]],
      });
      const quoteUsd = (Number(amounts[amounts.length - 1]) / 10 ** market.decimals) * debtPrice;
      const oracleUsd = (Number(amount) / 10 ** c.decimals) * prices[symbol]!;
      out[symbol] = Math.max(0, 1 - quoteUsd / oracleUsd);
    }
    return out;
  }
}
