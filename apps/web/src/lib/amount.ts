import { formatUnits, parseUnits } from 'viem';

/**
 * Token amounts in the UI stay in base units (bigint) end to end. Floats are only used for
 * display and for limits derived from USD prices, and those are floored before use.
 */

/** Exact decimal string for a base-unit amount; `parseInput(toInput(x, d), d) === x`. */
export const toInput = (value: bigint, decimals: number): string => formatUnits(value, decimals);

/** Parses user input into base units; null when empty, malformed (incl. exponents) or not positive. */
export function parseInput(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === '.') return null;
  try {
    const value = parseUnits(t, decimals);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** Converts a float number of token units to base units, rounding down at 6 decimals. */
export function floorUnits(units: number, decimals: number): bigint {
  if (!Number.isFinite(units) || units <= 0) return 0n;
  const d = Math.min(6, decimals);
  return BigInt(Math.floor(units * 10 ** d)) * 10n ** BigInt(decimals - d);
}
