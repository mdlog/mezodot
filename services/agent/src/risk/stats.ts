/** Descriptive statistics on return series. Returns are simple per-period returns (0.01 = +1%). */

export const HOURS_PER_YEAR = 24 * 365;

export const simpleReturns = (prices: number[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) if (prices[i - 1] > 0) out.push(prices[i] / prices[i - 1] - 1);
  return out;
};

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Sample standard deviation (n − 1). */
export const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Sample skewness (third standardised moment). */
export const skewness = (xs: number[]): number => {
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  return xs.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / xs.length;
};

/** Sample kurtosis (non-excess; normal = 3). */
export const kurtosis = (xs: number[]): number => {
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 3;
  return xs.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / xs.length;
};

/** Per-period Sharpe ratio (risk-free = 0). */
export const sharpe = (xs: number[]): number => {
  const s = stdev(xs);
  return s === 0 ? 0 : mean(xs) / s;
};

export const annualize = (perPeriodVol: number, periodsPerYear = HOURS_PER_YEAR): number => perPeriodVol * Math.sqrt(periodsPerYear);

export const maxDrawdown = (prices: number[]): number => {
  let peak = -Infinity;
  let worst = 0;
  for (const p of prices) {
    peak = Math.max(peak, p);
    if (peak > 0) worst = Math.max(worst, (peak - p) / peak);
  }
  return worst;
};

/** Historical Value-at-Risk: the loss (positive number) at the given confidence, e.g. 0.99. */
export const historicalVaR = (returns: number[], confidence: number): number => {
  if (!returns.length) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor((1 - confidence) * sorted.length) - 1);
  return Math.max(0, -sorted[idx]);
};

/** Compounded return over `horizon` consecutive periods, as a new series. */
export const horizonReturns = (prices: number[], horizon: number): number[] => {
  const out: number[] = [];
  for (let i = horizon; i < prices.length; i++) if (prices[i - horizon] > 0) out.push(prices[i] / prices[i - horizon] - 1);
  return out;
};
