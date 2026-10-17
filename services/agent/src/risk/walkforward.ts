import { deflatedSharpe } from './dsr';
import { kurtosis, mean, sharpe, skewness, stdev } from './stats';

export type LeverageParams = {
  /** Borrow cost per period (e.g. annual MUSD borrow rate / 8760 for hourly data). */
  borrowRatePerPeriod: number;
  /** Liquidation threshold of the collateral (fraction). */
  liquidationThreshold: number;
  /** Liquidation bonus paid out of the position when liquidated (fraction). */
  liquidationBonus: number;
};

/**
 * Per-period equity returns of a position rebalanced to constant leverage L on an asset,
 * financed in MUSD: r_e = L·r − (L − 1)·b. If the move breaches the liquidation threshold,
 * the period also loses the liquidation bonus on the collateral.
 */
export function leveragedReturns(assetReturns: number[], leverage: number, p: LeverageParams): number[] {
  const startLtv = (leverage - 1) / leverage;
  return assetReturns.map((r) => {
    let re = leverage * r - (leverage - 1) * p.borrowRatePerPeriod;
    const ltvAfter = startLtv / (1 + r);
    if (ltvAfter > p.liquidationThreshold) re -= leverage * p.liquidationBonus;
    return Math.max(-1, re);
  });
}

export type WalkForwardResult = {
  grid: number[];
  windows: { trainStart: number; testStart: number; chosen: number; trainSharpe: number; testSharpe: number }[];
  oosReturns: number[];
  /** Per-period out-of-sample Sharpe of the concatenated test windows. */
  oosSharpe: number;
  /** Per-period Sharpe of each grid point over the full sample (the "trials"). */
  trialSharpes: number[];
  deflatedSharpe: number;
  /** Most frequently selected leverage. */
  modalLeverage: number;
};

/**
 * Rolling walk-forward: in each train window pick the leverage with the best Sharpe, then
 * evaluate it on the following test window. The OOS Sharpe is deflated for the number of
 * leverage levels tried, guarding against selection bias (backtest overfitting).
 */
export function walkForward(assetReturns: number[], grid: number[], trainLen: number, testLen: number, p: LeverageParams): WalkForwardResult {
  const windows: WalkForwardResult['windows'] = [];
  const oosReturns: number[] = [];
  const series = new Map(grid.map((l) => [l, leveragedReturns(assetReturns, l, p)] as const));

  for (let start = 0; start + trainLen + testLen <= assetReturns.length; start += testLen) {
    const testStart = start + trainLen;
    let chosen = grid[0];
    let best = -Infinity;
    for (const l of grid) {
      const s = sharpe(series.get(l)!.slice(start, testStart));
      if (s > best) {
        best = s;
        chosen = l;
      }
    }
    const test = series.get(chosen)!.slice(testStart, testStart + testLen);
    oosReturns.push(...test);
    windows.push({ trainStart: start, testStart, chosen, trainSharpe: best, testSharpe: sharpe(test) });
  }

  const trialSharpes = grid.map((l) => sharpe(series.get(l)!));
  const oosSharpe = sharpe(oosReturns);
  const trialVar = stdev(trialSharpes) ** 2 || 1e-6;
  const dsr = oosReturns.length > 1 ? deflatedSharpe(oosSharpe, oosReturns.length, skewness(oosReturns), kurtosis(oosReturns), grid.length, trialVar) : 0;

  const counts = new Map<number, number>();
  for (const w of windows) counts.set(w.chosen, (counts.get(w.chosen) ?? 0) + 1);
  const modalLeverage = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? grid[0];

  return { grid, windows, oosReturns, oosSharpe, trialSharpes, deflatedSharpe: dsr, modalLeverage };
}

export const meanReturn = mean;
