import { describe, expect, it } from 'vitest';
import { maxUint256, type Address } from 'viem';
import { BTC_GAS_RESERVE, MEZO_BTC } from '../lib/btc';
import { assetsFor, sharesFor } from '../lib/shares';
import { borrowBound, exactUnits, sharePostBound, supplyBound, tightest, tokenPostBound, truncatedUnits, borrowHeadroomUsd } from './limits';

const MUSD = 10n ** 18n;
// 1 pMUSD (24 decimals) = 1.1 MUSD (18 decimals); 1,000 MUSD supplied, 400 lent out.
const musd = {
  symbol: 'MUSD',
  receiptSymbol: 'pMUSD',
  shareDecimals: 24,
  exchangeRate: 11n * 10n ** 17n,
  supplyCap: maxUint256,
  borrowCap: maxUint256,
  totalAssets: 1_000n * MUSD,
  totalBorrows: 400n * MUSD,
  cash: 600n * MUSD,
};
const SHARE = 10n ** 24n;

describe('action MAX', () => {
  it('takes the tightest bound, the first one naming the limit on a tie', () => {
    const a = { max: 5n, limit: 'a' };
    expect(tightest(a)).toBe(a);
    expect(tightest(a, { max: 3n, limit: 'b' }, { max: 4n, limit: 'c' })).toEqual({ max: 3n, limit: 'b' });
    expect(tightest(a, { max: 5n, limit: 'b' })).toBe(a);
  });

  it('caps supply at what the pool still accepts under its supply cap', () => {
    expect(supplyBound(musd, 50n * MUSD)).toEqual({ max: 50n * MUSD, limit: 'your MUSD wallet balance' });
    expect(supplyBound({ ...musd, supplyCap: 1_020n * MUSD }, 50n * MUSD)).toEqual({
      max: 20n * MUSD,
      limit: 'what the MUSD pool still accepts under its supply cap',
    });
    // A full pool takes nothing (supplyBlocked says why); a wallet that fits the room exactly is named for the wallet.
    expect(supplyBound({ ...musd, supplyCap: 900n * MUSD }, 50n * MUSD).max).toBe(0n);
    expect(supplyBound({ ...musd, supplyCap: 1_050n * MUSD }, 50n * MUSD).limit).toBe('your MUSD wallet balance');
  });

  it('caps borrowing at the borrow limit, the pool cash and the borrow cap', () => {
    expect(borrowBound(musd, 100n * MUSD)).toEqual({ max: 100n * MUSD, limit: 'your borrow limit' });
    expect(borrowBound(musd, 700n * MUSD)).toEqual({ max: 600n * MUSD, limit: "the pool's available liquidity" });
    expect(borrowBound({ ...musd, borrowCap: 450n * MUSD }, 100n * MUSD)).toEqual({
      max: 50n * MUSD,
      limit: 'what the MUSD pool can still lend under its borrow cap',
    });
    expect(borrowBound({ ...musd, borrowCap: 400n * MUSD }, 100n * MUSD).max).toBe(0n);
  });

  it('caps posted pool shares at the collateral cap, which counts shares', () => {
    const pMusd = { symbol: 'pMUSD', cap: maxUint256, total: 0n };
    // Uncapped: every wallet share, valued in MUSD.
    expect(sharePostBound(musd, pMusd, 10n * SHARE)).toEqual({ shares: 10n * SHARE, max: 11n * MUSD, limit: 'your pMUSD balance' });
    // 4 shares of room left: MAX posts exactly those, shown as their 4.4 MUSD.
    const capped = sharePostBound(musd, { ...pMusd, cap: 10n * SHARE, total: 6n * SHARE }, 10n * SHARE);
    expect(capped).toEqual({ shares: 4n * SHARE, max: (44n * MUSD) / 10n, limit: 'what pMUSD collateral still accepts under its cap' });
    expect(sharePostBound(musd, { ...pMusd, cap: 6n * SHARE, total: 6n * SHARE }, 10n * SHARE)).toMatchObject({ shares: 0n, max: 0n });
  });

  it('never lets a typed amount at the share MAX post more shares than it allows', () => {
    // An exchange rate that does not divide evenly: flooring both ways must stay within the room.
    const odd = { ...musd, exchangeRate: 1_234_567_890_123_456_789n };
    for (const room of [1n, 7n, 999_999_999n, 3n * SHARE + 17n]) {
      const bound = sharePostBound(odd, { symbol: 'pMUSD', cap: room, total: 0n }, 10n * SHARE);
      expect(bound.max).toBe(assetsFor(odd, room));
      expect(sharesFor(odd, bound.max) <= room).toBe(true);
    }
  });

  it('caps posted BTC at the collateral cap and keeps the gas reserve', () => {
    const btc = { symbol: 'BTC', token: MEZO_BTC as Address, decimals: 18, cap: maxUint256, total: 0n };
    const held = 10n ** 18n;
    expect(tokenPostBound(btc, held)).toEqual({ max: held - BTC_GAS_RESERVE, limit: 'your BTC wallet balance (keeping 0.0002 BTC for gas)' });
    expect(tokenPostBound(btc, BTC_GAS_RESERVE / 2n).max).toBe(0n);
    expect(tokenPostBound({ ...btc, cap: 5n * 10n ** 17n, total: 2n * 10n ** 17n }, held)).toEqual({
      max: 3n * 10n ** 17n,
      limit: 'what BTC collateral still accepts under its cap',
    });
    // A token that is not the gas token keeps nothing back.
    expect(tokenPostBound({ ...btc, symbol: 'tBTC', token: '0x00000000000000000000000000000000000000b7' }, held)).toEqual({
      max: held,
      limit: 'your tBTC wallet balance',
    });
  });

  it('prints limits exactly, digits grouped', () => {
    expect(exactUnits(1_234_567_890_000_000_000_001n, 18)).toBe('1,234.567890000000000001');
    expect(exactUnits(999_999_900n, 9)).toBe('0.9999999');
    expect(exactUnits(1_000_000n * MUSD, 18)).toBe('1,000,000');
    expect(exactUnits(0n, 18)).toBe('0');
  });
});

describe('MAX labels', () => {
  it('truncate instead of rounding up past the real MAX', () => {
    expect(truncatedUnits(999_960_000_000_000_000n, 18, 4)).toBe('0.9999');
    expect(truncatedUnits(10n ** 18n, 18, 4)).toBe('1');
    expect(truncatedUnits(1_234_500_000_000_000_000_000n, 18, 2)).toBe('1,234.5');
    expect(truncatedUnits(1n, 18, 6)).toBe('0');
  });
});

describe('borrow headroom', () => {
  it('keeps the limit buffer spare, so MAX survives a small price move however large the debt', () => {
    const v = { borrowLimitUsd: 10_100, debtUsd: 9_000, availableUsd: 1_100 };
    expect(borrowHeadroomUsd(v)).toBeCloseTo(10_100 / 1.01 - 9_000, 9); // 1,000, not 0.999 × 1,100
    expect(borrowHeadroomUsd({ borrowLimitUsd: 10_000, debtUsd: 9_950, availableUsd: 50 })).toBe(0);
    expect(borrowHeadroomUsd({ borrowLimitUsd: 10_000, debtUsd: 0, availableUsd: 0 })).toBe(0); // borrowing blocked
    expect(borrowHeadroomUsd(null)).toBe(0);
  });
});
