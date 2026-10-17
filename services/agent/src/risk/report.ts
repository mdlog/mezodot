import { join } from 'node:path';
import { perSecondToAnnual, readProtocol, symbolForPriceKey, type PriceSymbol, type ProtocolState } from '@mezodot/sdk';
import type { Context } from '../context';
import { JsonStore } from '../store';
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
  currentLtv: number | null;
  currentLt: number | null;
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

export type LoopCarry = { leverage: number; netApy: number }[];

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
const COINGECKO_IDS: Record<PriceSymbol, string> = { ETH: 'ethereum', MEZO: 'mezo', MUSD: 'mezo-usd', USDC: 'usd-coin' };

/** Highest LTV whose buffer to the liquidation threshold survives a VaR99 move: LT × (1 − VaR). */
export const recommendLtv = (lt: number, var99: number): number => Math.max(0, lt * (1 - var99));

const lastN = <T,>(xs: T[], n: number) => xs.slice(Math.max(0, xs.length - n));

export function buildReport(env: string, histories: PriceHistory[], protocol: ProtocolState | null, now = Date.now()): RiskReport {
  const notes: string[] = [];
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const musdBorrowApy = musd ? perSecondToAnnual(musd.borrowRatePerSecond) : 0;
  const musdSupplyApy = musd ? perSecondToAnnual(musd.supplyRatePerSecond) : 0;
  if (!protocol) notes.push('On-chain parameters unavailable; LTV comparison skipped.');

  const assets: AssetRisk[] = histories.map((h) => {
    const r1h = simpleReturns(h.p);
    const collateral = protocol?.collaterals.find((c) => symbolForPriceKey(c.priceKey) === h.symbol) ?? null;
    const var1h = historicalVaR(r1h, 0.99);
    const currentLt = collateral ? collateral.ltBps / 10_000 : null;
    const currentLtv = collateral ? collateral.ltvBps / 10_000 : null;
    const recommendedLtv = currentLt !== null ? recommendLtv(currentLt, var1h) : null;
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
      var99_24h: historicalVaR(horizonReturns(h.p, 24), 0.99),
      currentLtv,
      currentLt,
      recommendedLtv,
      verdict: currentLtv === null || recommendedLtv === null ? 'n/a' : currentLtv <= recommendedLtv ? 'ok' : 'tighten',
    };
  });

  const strategies: StrategyRisk[] = [];
  for (const symbol of ['ETH', 'MEZO'] as const) {
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

  const loopCarry = LEVERAGE_GRID.map((leverage) => ({ leverage, netApy: leverage * musdSupplyApy - (leverage - 1) * musdBorrowApy }));
  if (musd && musdBorrowApy > musdSupplyApy) notes.push('MUSD loop carry is negative without external incentives: borrow APY exceeds supply APY by construction (supply = borrow × utilization × (1 − reserve factor)).');

  return { generatedAt: now, env, dsrThreshold: DSR_THRESHOLD, assets, strategies, loopCarry, rates: { musdBorrowApy, musdSupplyApy }, notes };
}

/** 90 days of hourly prices from CoinGecko's public API. */
export async function fetchHistory(symbol: PriceSymbol, fetchImpl: typeof fetch = fetch): Promise<PriceHistory> {
  const res = await fetchImpl(`https://api.coingecko.com/api/v3/coins/${COINGECKO_IDS[symbol]}/market_chart?vs_currency=usd&days=90`);
  if (!res.ok) throw new Error(`CoinGecko ${symbol}: HTTP ${res.status}`);
  const body = (await res.json()) as { prices: [number, number][] };
  return { symbol, source: 'coingecko', t: body.prices.map((x) => x[0]), p: body.prices.map((x) => x[1]) };
}

/** Periodically rebuilds the risk report; keeps the last good report when a source fails. */
export class RiskEngine {
  private readonly store: JsonStore<{ report: RiskReport | null; error: string | null }>;

  constructor(
    private readonly ctx: Context,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new JsonStore(join(ctx.config.stateDir, `risk-${ctx.config.env}.json`), { report: null, error: null });
  }

  report(): RiskReport | null {
    return this.store.get().report;
  }

  lastError(): string | null {
    return this.store.get().error;
  }

  async refresh(): Promise<RiskReport | null> {
    try {
      const histories: PriceHistory[] = [];
      for (const s of ['ETH', 'MEZO', 'MUSD', 'USDC'] as const) {
        histories.push(await fetchHistory(s, this.fetchImpl));
        await new Promise((r) => setTimeout(r, 1_500)); // stay within CoinGecko's public rate limit
      }
      const protocol = await readProtocol(this.ctx.hub.client, this.ctx.hub.deployment).catch(() => null);
      const report = buildReport(this.ctx.config.env, histories, protocol);
      this.store.update((s) => {
        s.report = report;
        s.error = null;
      });
      this.ctx.log('risk', 'report refreshed', { assets: report.assets.length, strategies: report.strategies.length });
      return report;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.update((s) => {
        s.error = message;
      });
      this.ctx.log('risk', 'refresh failed', { error: message });
      return this.report();
    }
  }
}
