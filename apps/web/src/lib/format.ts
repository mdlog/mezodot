export const fmt = (n: number, digits = 0): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

export const money = (n: number, digits = 0): string => `${n < 0 ? '−' : ''}$${fmt(Math.abs(n), digits)}`;

/** Compact USD: $46.10M, $9.6K, $840. */
export const compactUsd = (n: number): string => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K` : money(n));

export const pct = (ratio: number, digits = 1): string => `${fmt(ratio * 100, digits)}%`;

/** Health factor with the "no debt" case rendered as an em dash. */
export const fmtHealth = (hf: number): string => (Number.isFinite(hf) ? `${hf.toFixed(2)}×` : '—');

const hex4 = () =>
  Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');

/** Illustrative transaction reference (never a real hash). */
export const fakeTxRef = (): string => `0x${hex4()}…${hex4()}`;

export const uid = (): string => `act-${Date.now().toString(36)}-${hex4()}`;

export const timeAgo = (at: number, now = Date.now()): string => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
