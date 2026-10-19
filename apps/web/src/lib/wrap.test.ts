import { describe, expect, it } from 'vitest';
import { GAS_RESERVE_UNITS, MIN_GAS_RESERVE, spendableWeth, wrapNeeded } from './wrap';

const E18 = 10n ** 18n;

describe('depositing WETH from a wallet that holds native ETH', () => {
  it('counts native ETH beyond a gas reserve as spendable WETH', () => {
    const gasPrice = 10_000_000_000n; // 10 gwei
    const reserve = gasPrice * GAS_RESERVE_UNITS; // 0.006 ETH
    expect(spendableWeth(0n, E18 / 20n, gasPrice)).toBe(E18 / 20n - reserve); // 0.05 ETH, no WETH
    expect(spendableWeth(E18 / 1000n, E18 / 20n, gasPrice)).toBe(E18 / 1000n + E18 / 20n - reserve);
    expect(spendableWeth(E18 / 1000n, reserve / 2n, gasPrice)).toBe(E18 / 1000n); // not enough ETH for gas
  });

  it('keeps at least 0.0005 ETH for gas when gas is nearly free (Sepolia: 3,837 wei)', () => {
    expect(MIN_GAS_RESERVE).toBe(E18 / 2000n);
    expect(spendableWeth((2n * E18) / 1000n, (58n * E18) / 1000n, 3_837n)).toBe((2n * E18) / 1000n + (58n * E18) / 1000n - MIN_GAS_RESERVE);
  });

  it('wraps only the shortfall', () => {
    expect(wrapNeeded(0n, 2n * E18)).toBe(2n * E18);
    expect(wrapNeeded(E18, 2n * E18)).toBe(E18);
    expect(wrapNeeded(3n * E18, 2n * E18)).toBe(0n);
  });
});
