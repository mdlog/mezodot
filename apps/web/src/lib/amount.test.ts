import { describe, expect, it } from 'vitest';
import { floorUnits, parseInput, toInput } from './amount';

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
