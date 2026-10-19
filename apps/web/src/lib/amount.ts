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

/** Converts a float number of token units to base units, rounding up at 6 decimals: for amounts that must not fall short. */
export function ceilUnits(units: number, decimals: number): bigint {
  if (!Number.isFinite(units) || units <= 0) return 0n;
  const d = Math.min(6, decimals);
  return BigInt(Math.ceil(units * 10 ** d)) * 10n ** BigInt(decimals - d);
}

/**
 * A round default amount at or below `max`, as input text: two significant digits rounded down (54.67 → "54",
 * 0.001012 → "0.001"); "" when nothing of at least 0.000001 fits.
 */
export function roundedInput(max: number): string {
  if (!Number.isFinite(max) || max < 1e-6) return '';
  const exponent = Math.floor(Math.log10(max)) - 1;
  const decimals = Math.min(6, Math.max(0, -exponent));
  const step = 10 ** Math.max(exponent, -6);
  // The epsilon keeps float noise (0.3 / 0.1 = 2.999…) from dropping a digit.
  const value = Math.floor(max / step + 1e-9) * step;
  return value
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}
