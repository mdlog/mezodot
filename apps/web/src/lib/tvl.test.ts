import { describe, expect, it } from 'vitest';
import { PRICE_KEYS, type ProtocolState } from '@mezodot/sdk';
import { prices, protocol as hub } from '../test/fixtures';
import { collateralTotals, protocolTotals } from './tvl';

const E18 = 10n ** 18n;

describe('protocol totals (audit: TVL counted borrowed and looped liquidity)', () => {
  // pMUSD: 3,000 MUSD deposited, then a 1,000 MUSD loop at 4x. Cash 4,000 (incl. the 2.7 fee in reserves),
  // borrows 3,002.7, supplied 7,000: only 4,000 MUSD ever entered.
  const protocol = {
    markets: [
      { decimals: 18, priceKey: PRICE_KEYS.MUSD, cash: 4_000n * E18, totalAssets: 7_000n * E18, totalBorrows: 3_002_700n * 10n ** 15n },
      { decimals: 18, priceKey: PRICE_KEYS.MEZO, cash: 0n, totalAssets: 0n, totalBorrows: 0n },
    ],
    collaterals: [
      { isShare: true, decimals: 18, priceKey: PRICE_KEYS.MUSD, total: 4_000n * 10n ** 24n }, // the loop's pMUSD: already counted
      { isShare: false, isRemote: false, decimals: 18, priceKey: PRICE_KEYS.BTC, total: E18 / 2n }, // BTC in VaultManager
      { isShare: false, isRemote: true, decimals: 6, priceKey: PRICE_KEYS.USDC, total: 250_000_000n }, // USDC on a spoke
    ],
  } as unknown as ProtocolState;
  const prices = { MUSD: 0.99, BTC: 80_000, USDC: 1 };

  it('counts what entered once: idle cash plus BTC and spoke collateral, not the loop multiple', () => {
    const t = protocolTotals(protocol, prices);
    expect(t.tvl).toBeCloseTo(4_000 * 0.99 + 40_000 + 250, 6);
    expect(t.supplied).toBeCloseTo(7_000 * 0.99, 6);
    expect(t.borrowed).toBeCloseTo(3_002.7 * 0.99, 6);
  });

  it('counts unpriced assets as zero', () => {
    expect(protocolTotals(protocol, { BTC: 80_000 }).tvl).toBeCloseTo(40_000, 6);
  });
});

describe('collateral totals', () => {
  it('values posted pTokens through the pool exchange rate, and BTC and spoke tokens as held', () => {
    const rows = collateralTotals(hub, prices);
    expect(rows.map((r) => r.collateral.symbol)).toEqual(['pMUSD', 'BTC', 'WETH']);
    // 1,000 pMUSD at 1.1 MUSD each; 2 BTC at $60,000; 3 WETH at $3,000.
    expect(rows[0].units).toBeCloseTo(1_100, 9);
    expect(rows[0].valueUsd).toBeCloseTo(1_100, 9);
    expect(rows[1].units).toBeCloseTo(2, 9);
    expect(rows[1].valueUsd).toBeCloseTo(120_000, 9);
    expect(rows[2].units).toBeCloseTo(3, 9);
    expect(rows[2].valueUsd).toBeCloseTo(9_000, 9);
  });

  it('values collateral without a price at zero', () => {
    expect(collateralTotals(hub, { MUSD: 1 }).map((r) => r.valueUsd)).toEqual([expect.closeTo(1_100, 9), 0, 0]);
  });
});
