export const fmt = (n: number, digits = 0): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

/**
 * US dollars. Without `digits` the precision follows the size: cents below $1,000 (positions on testnet are
 * often worth cents: 50 MEZO ≈ $0.15), whole dollars above, and <$0.01 for a non-zero amount under a cent.
 */
export const money = (n: number, digits?: number): string => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (digits === undefined && abs > 0 && abs < 0.005) return `${sign}<$0.01`;
  return `${sign}$${fmt(abs, digits ?? (abs >= 1_000 ? 0 : 2))}`;
};

/** Compact USD: $46.10M, $9.6K, $840.00, $0.15. */
export const compactUsd = (n: number): string => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K` : money(n));

export const pct = (ratio: number, digits = 1): string => `${fmt(ratio * 100, digits)}%`;

/** Health factor with the "no debt" case rendered as an em dash. */
export const fmtHealth = (hf: number): string => (Number.isFinite(hf) ? `${hf.toFixed(2)}×` : '—');

export const timeAgo = (at: number, now = Date.now()): string => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/** Token amount (bigint base units) as a JS number — for display only. */
export const units = (value: bigint, decimals: number): number => Number(value) / 10 ** decimals;

export const fmtToken = (value: bigint, decimals: number, digits = 2): string => fmt(units(value, decimals), digits);

/** Annual rate (fraction) as a percentage string. */
export const fmtApy = (rate: number, digits = 2): string => `${(rate * 100).toFixed(digits)}%`;

export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
