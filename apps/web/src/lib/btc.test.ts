import { describe, expect, it } from 'vitest';
import { BTC_GAS_RESERVE, isGasToken, spendableBtc } from './btc';

describe('BTC as collateral on Mezo (it is also the gas token)', () => {
  it('keeps a gas reserve back from what can be committed', () => {
    expect(spendableBtc(15_000_000_000_000_000n)).toBe(15_000_000_000_000_000n - BTC_GAS_RESERVE);
    expect(spendableBtc(BTC_GAS_RESERVE)).toBe(0n);
    expect(spendableBtc(0n)).toBe(0n);
  });

  it('recognises the BTC precompile whatever the address casing', () => {
    expect(isGasToken('0x7b7C000000000000000000000000000000000000')).toBe(true);
    expect(isGasToken('0x7B7c000000000000000000000000000000000001')).toBe(false); // MEZO
  });
});
