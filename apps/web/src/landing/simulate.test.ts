import { describe, expect, it } from 'vitest';
import { protocol } from '../test/fixtures';
import { simulateBorrow, spokeCollateral } from './simulate';

describe('borrow simulation', () => {
  it('prices a fresh position the way VaultManager does: limit from LTV, health from the liquidation threshold', () => {
    // 0.5 WETH at $2,400 = $1,200; 75% LTV → 900 MUSD limit; half of it borrowed = 450 MUSD.
    const s = simulateBorrow({ amount: 0.5, price: 2_400, ltvBps: 7_500, ltBps: 8_000, musdPrice: 1, share: 0.5 });
    expect(s.valueUsd).toBeCloseTo(1_200, 9);
    expect(s.limitMusd).toBeCloseTo(900, 9);
    expect(s.borrowMusd).toBeCloseTo(450, 9);
    // 1,200 × 80% / 450.
    expect(s.healthFactor).toBeCloseTo(2.133333, 6);
    // ETH at which 0.5 × price × 80% = 450.
    expect(s.liquidationPrice).toBeCloseTo(1_125, 9);
  });

  it('counts MUSD at its own price: a cheaper MUSD buys more of it, against the same dollars of debt', () => {
    const s = simulateBorrow({ amount: 0.5, price: 2_400, ltvBps: 7_500, ltBps: 8_000, musdPrice: 0.99, share: 1 });
    expect(s.limitMusd).toBeCloseTo(909.090909, 6);
    // $900 of debt against $960 at the threshold.
    expect(s.healthFactor).toBeCloseTo(1.066667, 6);
    expect(s.liquidationPrice).toBeCloseTo(2_250, 6);
  });

  it('has no debt, no health limit and no liquidation price when nothing is borrowed or nothing is priced', () => {
    for (const s of [
      simulateBorrow({ amount: 0.5, price: 2_400, ltvBps: 7_500, ltBps: 8_000, musdPrice: 1, share: 0 }),
      simulateBorrow({ amount: 0.5, price: 0, ltvBps: 7_500, ltBps: 8_000, musdPrice: 1, share: 0.5 }),
    ]) {
      expect(s.borrowMusd).toBe(0);
      expect(s.healthFactor).toBe(Infinity);
      expect(s.liquidationPrice).toBeNull();
    }
  });
});

describe('spoke collateral lookup', () => {
  it('finds what a spoke accepts by its Wormhole chain and token, and nothing else', () => {
    expect(spokeCollateral(protocol, 10_004, 'WETH')?.id).toBe(2);
    expect(spokeCollateral(protocol, 10_002, 'WETH')).toBeUndefined();
    expect(spokeCollateral(protocol, 10_004, 'USDC')).toBeUndefined();
  });
});
