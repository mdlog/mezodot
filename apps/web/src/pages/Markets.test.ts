import { describe, expect, it } from 'vitest';
import type { MarketState } from '@mezodot/sdk';
import { ratesExplainer } from './Markets';

const WAD = 10n ** 18n;
const market = (patch: Partial<MarketState>) => ({ symbol: 'MUSD', reserveFactor: WAD / 10n, ...patch }) as MarketState;

describe('rates explainer', () => {
  it('quotes the live rate model, reserve factor and liquidation fee instead of the deployment defaults', () => {
    const text = ratesExplainer({
      markets: [market({ reserveFactor: (WAD * 15n) / 100n, rateModel: { base: 0.01, slope1: 0.04, kink: 0.75, slope2: 0.9 } })],
      liquidationFeeBps: 2_000,
    });
    expect(text).toContain('MUSD 5% at 75% utilization');
    expect(text).toContain('(1 − 15% reserve factor)');
    expect(text).toContain('Flash-loan fees (0.09%) go to reserves');
    expect(text).toContain('20% of each liquidation bonus to the treasury');
    expect(text).not.toMatch(/6% at 80%|10% reserve factor/);
  });

  it('names each pool when reserve factors differ, and stays neutral without a rate model', () => {
    const text = ratesExplainer({ markets: [market({}), market({ symbol: 'MEZO', reserveFactor: (WAD * 3n) / 10n })], liquidationFeeBps: 1_000 });
    expect(text).toContain('reserve factor: MUSD 10%, MEZO 30%');
    expect(text).toMatch(/^Kinked curve per pool, steep above the kink\. /);
  });
});
