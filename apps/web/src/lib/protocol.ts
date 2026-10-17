/**
 * Pure lending / leverage math used by every screen.
 * No React, no side effects — everything here is unit tested.
 */

/** Pool utilization as a 0..1 ratio. */
export const utilization = (supplied: number, borrowed: number): number => (supplied > 0 ? borrowed / supplied : 0);

/**
 * Base supply APY paid out of borrower interest (percent).
 * Suppliers can never earn more than borrowers pay: borrowApy × utilization × (1 − reserveFactor).
 */
export const supplyApy = (borrowApyPct: number, util: number, reserveFactor: number): number => borrowApyPct * util * (1 - reserveFactor);

export const availableLiquidity = (supplied: number, borrowed: number): number => Math.max(0, supplied - borrowed);

/* ERC-4626 conversions ---------------------------------------------------- */

export const sharesForAssets = (assets: number, rate: number): number => assets / rate;
export const assetsForShares = (shares: number, rate: number): number => shares * rate;

/* Position risk ----------------------------------------------------------- */

export const loanToValue = (collateralUsd: number, debtUsd: number): number => (collateralUsd > 0 ? debtUsd / collateralUsd : 0);

/** Health factor; `Infinity` when there is no debt. Liquidatable below 1. */
export const healthFactor = (collateralUsd: number, debtUsd: number, liquidationThreshold: number): number =>
  debtUsd > 0 ? (collateralUsd * liquidationThreshold) / debtUsd : Infinity;

/** Additional debt that can be opened before hitting the max LTV. */
export const borrowCapacity = (collateralUsd: number, debtUsd: number, maxLtv: number): number => Math.max(0, collateralUsd * maxLtv - debtUsd);

/**
 * wETH price at which the position becomes liquidatable, given the other
 * (price-stable) collateral. Returns 0 when other collateral alone covers the debt.
 */
export const liquidationPrice = (wethAmount: number, otherCollateralUsd: number, debtUsd: number, liquidationThreshold: number): number | null => {
  if (wethAmount <= 0 || debtUsd <= 0) return null;
  return Math.max(0, (debtUsd / liquidationThreshold - otherCollateralUsd) / wethAmount);
};

export type HealthStatus = { label: 'Healthy' | 'Monitor' | 'At risk'; tone: 'ok' | 'warn' | 'danger' };

/** One set of thresholds used by every screen. */
export const healthStatus = (hf: number): HealthStatus => {
  if (hf >= 1.5) return { label: 'Healthy', tone: 'ok' };
  if (hf >= 1.2) return { label: 'Monitor', tone: 'warn' };
  return { label: 'At risk', tone: 'danger' };
};

/* Leverage loop ----------------------------------------------------------- */

/** Highest leverage reachable by recursive borrowing at a given max LTV: 1 / (1 − LTV). */
export const maxLeverage = (maxLtv: number): number => 1 / (1 - maxLtv);

export type LoopParams = {
  /** Total APY earned on supplied collateral (base + rewards), percent. */
  supplyApyPct: number;
  borrowApyPct: number;
  maxLtv: number;
  liquidationThreshold: number;
};

export type LoopPlan = {
  principal: number;
  leverage: number;
  /** Gross supplied position. */
  gross: number;
  /** Flash-borrowed then re-borrowed MUSD. */
  debt: number;
  ltv: number;
  healthFactor: number;
  /** Net APY on the user's equity, percent. */
  netApy: number;
  /** % fall in collateral value (e.g. pMUSD depeg) that would trigger liquidation. */
  liquidationBuffer: number;
  error: string | null;
};

export const planLoop = (principal: number, leverage: number, p: LoopParams): LoopPlan => {
  const gross = principal * leverage;
  const debt = gross - principal;
  const ltv = loanToValue(gross, debt);
  const hf = healthFactor(gross, debt, p.liquidationThreshold);
  const netApy = principal > 0 ? (gross * p.supplyApyPct - debt * p.borrowApyPct) / principal : 0;
  const liquidationBuffer = Number.isFinite(hf) ? Math.max(0, 1 - 1 / hf) * 100 : 100;

  let error: string | null = null;
  if (!Number.isFinite(principal) || principal <= 0) error = 'Enter a valid MUSD amount';
  else if (leverage < 1) error = 'Leverage must be at least 1×';
  // Small epsilon so exactly-at-limit leverage (e.g. 3× at 66.7%) is never rejected by float noise.
  else if (ltv > p.maxLtv + 1e-9) error = `${leverage}× exceeds the ${(p.maxLtv * 100).toFixed(0)}% max LTV (max ${maxLeverage(p.maxLtv).toFixed(2)}×)`;

  return { principal, leverage, gross, debt, ltv, healthFactor: hf, netApy, liquidationBuffer, error };
};

/* Interest accrual -------------------------------------------------------- */

/** Compounds a value at an annual percentage over `days`. */
export const accrue = (value: number, apyPct: number, days: number): number => value * Math.pow(1 + apyPct / 100, days / 365);

/** Simple (non-compounding) reward emission over `days`. */
export const emission = (value: number, aprPct: number, days: number): number => (value * aprPct * days) / (100 * 365);

/* Input parsing ----------------------------------------------------------- */

/** Parses a user-entered amount; returns `null` for empty, non-numeric or non-positive input. */
export const parseAmount = (raw: string): number | null => {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};
