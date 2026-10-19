/**
 * Probabilistic and Deflated Sharpe Ratio — Bailey & López de Prado (2012, 2014).
 * All Sharpe ratios here are per-period (not annualised), matching the sample frequency.
 */

const EULER_GAMMA = 0.5772156649015329;

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 on erf, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new Error('normInv domain is (0, 1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * PSR: probability that the true Sharpe exceeds `benchmark`, given T observations with
 * sample skewness and (non-excess) kurtosis.
 */
export function probabilisticSharpe(sr: number, benchmark: number, observations: number, skew: number, kurt: number): number {
  if (observations < 2) return 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmark) * Math.sqrt(observations - 1)) / denom);
}

/** Expected maximum Sharpe among N independent trials with Sharpe variance `variance` under the null. */
export function expectedMaxSharpe(trials: number, variance: number): number {
  if (trials <= 1) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)));
}

/** DSR: PSR against the Sharpe one would expect from the best of `trials` random strategies. */
export function deflatedSharpe(sr: number, observations: number, skew: number, kurt: number, trials: number, trialSharpeVariance: number): number {
  return probabilisticSharpe(sr, expectedMaxSharpe(trials, trialSharpeVariance), observations, skew, kurt);
}
