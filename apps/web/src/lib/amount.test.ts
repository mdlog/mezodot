import { describe, expect, it } from 'vitest';
import { ceilUnits, floorUnits, parseInput, roundedInput, toInput } from './amount';

describe('exact amount inputs (final review I6)', () => {
  it('MAX round-trips exactly for random 18- and 6-decimal balances', () => {
    let seed = 123456789n;
    for (let i = 0; i < 5_000; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      const max = (seed % 10n ** 26n) + 1n;
      expect(parseInput(toInput(max, 18), 18)).toBe(max);
      const usdc = (seed % 10n ** 14n) + 1n;
      expect(parseInput(toInput(usdc, 6), 6)).toBe(usdc);
    }
    // The reviewer's counter-example.
    expect(parseInput(toInput(7574764402425599631997n, 18), 18)).toBe(7574764402425599631997n);
  });

  it('rejects empty, malformed and non-positive input', () => {
    for (const bad of ['', ' ', 'abc', '-1', '0', '0.0', '1e18', '1,5', '..']) expect(parseInput(bad, 18)).toBeNull();
    expect(parseInput('1.5', 6)).toBe(1_500_000n);
  });

  it('floors float limits so they never exceed the float they came from', () => {
    expect(floorUnits(2_255.9999999, 18)).toBe(2_255_999_999n * 10n ** 12n);
    expect(floorUnits(0.0000004, 18)).toBe(0n);
    expect(floorUnits(-1, 18)).toBe(0n);
    expect(floorUnits(Number.NaN, 6)).toBe(0n);
    expect(floorUnits(12.3456789, 6)).toBe(12_345_678n);
  });
});

describe('sizing helpers', () => {
  it('rounds a sale up so it never falls short', () => {
    expect(ceilUnits(1.5108741, 18)).toBe(1_510_875n * 10n ** 12n);
    expect(ceilUnits(0.0000001, 18)).toBe(10n ** 12n);
    expect(ceilUnits(0, 18)).toBe(0n);
    expect(ceilUnits(Number.NaN, 18)).toBe(0n);
  });

  it('suggests round default amounts at or below the limit', () => {
    expect(roundedInput(54.67)).toBe('54');
    expect(roundedInput(1_234)).toBe('1200');
    expect(roundedInput(0.3)).toBe('0.3');
    expect(roundedInput(5)).toBe('5');
    expect(roundedInput(0.001012)).toBe('0.001');
    expect(roundedInput(0.0999999)).toBe('0.099');
    expect(roundedInput(0.00000123)).toBe('0.000001');
    for (const bad of [0, -1, 1e-7, Infinity, Number.NaN]) expect(roundedInput(bad)).toBe('');
    // Always parseable, never above the limit.
    for (const max of [54.67, 0.001012, 2.5e-5, 7_777]) {
      expect(parseInput(roundedInput(max), 18)).not.toBeNull();
      expect(Number(roundedInput(max))).toBeLessThanOrEqual(max);
    }
  });
});
