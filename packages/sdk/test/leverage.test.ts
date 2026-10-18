import { describe, expect, it } from 'vitest';
import { liquidatorShare, planBtcClose, planBtcLeverage } from '../src';

const BTC = { btcPrice: 80_000, musdPrice: 1, ltvBps: 7_000, ltBps: 7_800 };

describe('BTC leverage preview (SwapLeverageManager)', () => {
  it('mirrors the contract test: 1 BTC to 2.5x at the oracle price', () => {
    const p = planBtcLeverage({ ...BTC, principal: 1, leverage: 2.5, quotedBtc: 1.5, slippageBps: 50 });
    expect(p.borrowMusd).toBeCloseTo(120_000, 9);
    expect(p.boughtBtc).toBe(1.5);
    expect(p.minBoughtBtc).toBeCloseTo(1.4925, 9);
    expect(p.postedBtc).toBe(2.5);
    expect(p.debtMusd).toBeCloseTo(120_108, 9);
    expect(p.healthFactor).toBeCloseTo((2.5 * 80_000 * 0.78) / 120_108, 9);
    // HF reaches 1 when BTC falls to debt / (posted × LT).
    expect(p.liquidationPrice).toBeCloseTo(120_108 / (2.5 * 0.78), 6);
    expect(p.maxLeverage).toBeCloseTo(1 / 0.3, 9);
    expect(p.error).toBeNull();
  });

  it('flags leverage the 70% LTV cannot carry, checked at the worst accepted swap', () => {
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.4 }).error).toMatch(/max LTV/);
    // 3.3x passes at the oracle price but not if the swap may return 2% less.
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.3 }).error).toBeNull();
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.3, slippageBps: 200 }).error).toMatch(/max LTV/);
    expect(planBtcLeverage({ ...BTC, principal: 0, leverage: 2 }).error).toMatch(/amount/);
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 1 }).error).toMatch(/above 1/);
  });

  it('reports how far the DEX quote is from the oracle', () => {
    const p = planBtcLeverage({ ...BTC, principal: 1, leverage: 2, quotedBtc: 0.95 });
    expect(p.priceImpact).toBeCloseTo(0.05, 9);
  });
});

describe('BTC close preview', () => {
  it('sells enough BTC for the debt, the flash fee and a buffer, and returns the rest', () => {
    // 2.5 BTC against 120,108 MUSD; selling all 2.5 BTC would fetch 200,000 MUSD.
    const c = planBtcClose({ collateralBtc: 2.5, debtMusd: 120_108, quotedMusdForAll: 200_000, slippageBps: 50 });
    const owed = 120_108 * 1.0009;
    expect(c.minProceeds).toBeCloseTo(owed, 6);
    expect(c.sellBtc).toBeGreaterThan(owed / 80_000);
    expect(c.sellBtc).toBeLessThan((owed / 80_000) * 1.01);
    expect(c.collateralBack).toBeCloseTo(2.5 - c.sellBtc, 12);
    expect(c.error).toBeNull();
  });

  it('cannot close when even selling everything would not repay', () => {
    expect(planBtcClose({ collateralBtc: 1, debtMusd: 90_000, quotedMusdForAll: 80_000 }).error).toMatch(/not enough/);
  });
});

describe('liquidation split', () => {
  it('gives the protocol its share of the bonus only', () => {
    // 1,100 units seized at a 10% bonus: 100 is bonus, the protocol keeps 10% of it.
    const s = liquidatorShare(1_100, 1_000, 1_000);
    expect(s.toProtocol).toBeCloseTo(10, 9);
    expect(s.toLiquidator).toBeCloseTo(1_090, 9);
    expect(liquidatorShare(1_100, 1_000, 0).toProtocol).toBe(0);
  });
});
