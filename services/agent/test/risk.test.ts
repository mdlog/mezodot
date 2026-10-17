import { describe, expect, it } from 'vitest';
import { deflatedSharpe, expectedMaxSharpe, normCdf, normInv, probabilisticSharpe } from '../src/risk/dsr';
import { annualize, historicalVaR, horizonReturns, kurtosis, maxDrawdown, sharpe, simpleReturns, skewness, stdev } from '../src/risk/stats';
import { leveragedReturns, walkForward } from '../src/risk/walkforward';
import { recommendLtv } from '../src/risk/report';

describe('normal distribution', () => {
  it('matches reference quantiles', () => {
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normCdf(0)).toBeCloseTo(0.5, 7); // A&S 7.1.26: |error| < 1.5e-7
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normInv(0.01)).toBeCloseTo(-2.326348, 5);
    expect(normInv(0.5)).toBeCloseTo(0, 9);
  });
});

describe('Sharpe deflation (Bailey & López de Prado)', () => {
  it('expected max Sharpe of 100 unit-variance trials ≈ 2.53', () => {
    expect(expectedMaxSharpe(100, 1)).toBeCloseTo(2.5303, 3);
    expect(expectedMaxSharpe(1, 1)).toBe(0);
  });

  it('PSR is 0.5 when the estimate equals the benchmark', () => {
    expect(probabilisticSharpe(0.1, 0.1, 1_000, 0, 3)).toBeCloseTo(0.5, 7);
  });

  it('PSR under normal returns uses sqrt(1 + SR²/2)', () => {
    const sr = 0.1;
    const expected = normCdf((sr * Math.sqrt(999)) / Math.sqrt(1 + (sr * sr) / 2));
    expect(probabilisticSharpe(sr, 0, 1_000, 0, 3)).toBeCloseTo(expected, 9);
  });

  it('negative skew and fat tails lower the PSR', () => {
    expect(probabilisticSharpe(0.1, 0, 500, -3, 10)).toBeLessThan(probabilisticSharpe(0.1, 0, 500, 0, 3));
  });

  it('more trials deflate the same Sharpe further', () => {
    expect(deflatedSharpe(0.1, 1_000, 0, 3, 50, 0.001)).toBeLessThan(deflatedSharpe(0.1, 1_000, 0, 3, 2, 0.001));
  });
});

describe('stats', () => {
  it('volatility, drawdown, VaR', () => {
    const r = Array.from({ length: 1_000 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(stdev(r)).toBeCloseTo(0.01, 4);
    expect(annualize(0.01)).toBeCloseTo(0.01 * Math.sqrt(8_760), 9);
    expect(skewness(r)).toBeCloseTo(0, 6);
    expect(kurtosis(r)).toBeCloseTo(1, 2);
    expect(maxDrawdown([100, 120, 90, 130])).toBeCloseTo(0.25, 12);
    expect(historicalVaR([-0.05, -0.02, 0, 0.01, 0.03], 0.8)).toBeCloseTo(0.05, 12);
    const sr = simpleReturns([100, 110, 99]);
    expect(sr[0]).toBeCloseTo(0.1, 12);
    expect(sr[1]).toBeCloseTo(99 / 110 - 1, 12);
    expect(horizonReturns([100, 101, 102, 110], 2)).toEqual([102 / 100 - 1, 110 / 101 - 1]);
    expect(sharpe([0.01, 0.01])).toBe(0);
  });
});

describe('walk-forward over leverage', () => {
  const params = { borrowRatePerPeriod: 0.06 / 8_760, liquidationThreshold: 0.8, liquidationBonus: 0.07 };

  it('leveraged returns subtract borrow cost and penalise liquidation-sized moves', () => {
    const [up] = leveragedReturns([0.01], 3, params);
    expect(up).toBeCloseTo(0.03 - 2 * params.borrowRatePerPeriod, 12);
    // 3× starts at 66.7% LTV; a −20% move pushes LTV to 83% > 80% → bonus lost.
    const [crash] = leveragedReturns([-0.2], 3, params);
    expect(crash).toBeCloseTo(Math.max(-1, -0.6 - 2 * params.borrowRatePerPeriod - 3 * 0.07), 12);
  });

  it('selects higher leverage on a steady uptrend and reports a positive OOS Sharpe', () => {
    const r = Array.from({ length: 600 }, (_, i) => 0.002 + (i % 2 ? 0.001 : -0.001));
    const wf = walkForward(r, [1.5, 2, 3], 200, 100, params);
    expect(wf.windows.length).toBe(4);
    expect(wf.oosSharpe).toBeGreaterThan(0);
    expect(wf.deflatedSharpe).toBeGreaterThan(0.5);
  });

  it('a pure-noise series is not called robust', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647 - 0.5;
    const r = Array.from({ length: 2_000 }, () => rand() * 0.02);
    const wf = walkForward(r, [1.5, 2, 2.5, 3, 3.5, 4], 500, 250, params);
    expect(wf.deflatedSharpe).toBeLessThan(0.95);
  });
});

describe('LTV recommendation', () => {
  it('keeps the buffer above the 1h VaR99 move', () => {
    // 1h VaR99 of 2% with LT 80% → LTV ≤ 80% × (1 − 2%) = 78.4%
    expect(recommendLtv(0.8, 0.02)).toBeCloseTo(0.784, 12);
    expect(recommendLtv(0.8, 2)).toBe(0);
  });
});

describe('buildReport', () => {
  it('produces asset risk, strategies and loop carry from histories', async () => {
    const { buildReport } = await import('../src/risk/report');
    const hours = 24 * 60;
    const wave = (base: number, amp: number) => Array.from({ length: hours }, (_, i) => base * (1 + amp * Math.sin(i / 10)));
    const t = Array.from({ length: hours }, (_, i) => i * 3_600_000);
    const report = buildReport(
      'test',
      [
        { symbol: 'ETH', source: 'fixture', t, p: wave(3_000, 0.05) },
        { symbol: 'MEZO', source: 'fixture', t, p: wave(0.008, 0.2) },
        { symbol: 'MUSD', source: 'fixture', t, p: wave(1, 0.001) },
      ],
      null,
    );
    expect(report.assets).toHaveLength(3);
    const eth = report.assets.find((a) => a.symbol === 'ETH')!;
    expect(eth.vol90dAnnual).toBeGreaterThan(0);
    expect(eth.maxDrawdown90d).toBeGreaterThan(0.05);
    expect(eth.verdict).toBe('n/a'); // no on-chain params supplied
    expect(report.strategies.map((s) => s.collateral)).toEqual(['ETH', 'MEZO']);
    expect(report.loopCarry).toHaveLength(6);
    expect(report.notes.join(' ')).toMatch(/On-chain parameters unavailable/);
  });
});
