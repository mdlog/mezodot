/**
 * Off-chain mirror of the contract formulas, for previews in the UI, agent and MCP tools.
 * Values use plain numbers (USD / token units), not wei. Test vectors in test/math.test.ts
 * match the Solidity tests so previews and on-chain results agree.
 */

export const BPS = 10_000;
export const SECONDS_PER_YEAR = 365 * 24 * 3600;
/** MezodotPool.FLASH_FEE_BPS */
export const FLASH_FEE_BPS = 9;
/** VaultManager.CLOSE_FACTOR_BPS */
export const CLOSE_FACTOR_BPS = 5_000;

export type RateModel = { base: number; slope1: number; kink: number; slope2: number };

/** Spec parameters (InterestRateModel constructor args as fractions). */
export const RATE_MODELS = {
  MUSD: { base: 0, slope1: 0.06, kink: 0.8, slope2: 0.8 },
  MEZO: { base: 0.02, slope1: 0.08, kink: 0.7, slope2: 1.0 },
} as const satisfies Record<string, RateModel>;

export const RESERVE_FACTOR = 0.1;

export const utilization = (cash: number, borrows: number, reserves = 0): number => {
  if (borrows <= 0) return 0;
  const supplied = cash + borrows - reserves;
  return supplied <= 0 ? 1 : Math.min(1, borrows / supplied);
};

/** InterestRateModel.borrowRatePerYear as a fraction (0.06 = 6%). */
export const borrowRate = (m: RateModel, util: number): number =>
  util <= m.kink ? m.base + (m.slope1 * util) / m.kink : m.base + m.slope1 + (m.slope2 * (util - m.kink)) / (1 - m.kink);

/** Supply rate = borrow rate × utilization × (1 − reserve factor). */
export const supplyRate = (m: RateModel, util: number, reserveFactor = RESERVE_FACTOR): number => borrowRate(m, util) * util * (1 - reserveFactor);

/** Converts an on-chain per-second WAD rate to an annual fraction. */
export const perSecondToAnnual = (ratePerSecondWad: bigint): number => (Number(ratePerSecondWad) / 1e18) * SECONDS_PER_YEAR;

export type CollateralPosition = { valueUsd: number; ltvBps: number; ltBps: number };

export type PositionSummary = {
  collateralUsd: number;
  borrowLimitUsd: number;
  adjustedCollateralUsd: number;
  debtUsd: number;
  /** Infinity when there is no debt. */
  healthFactor: number;
  availableUsd: number;
  ltv: number;
};

/** VaultManager._position: HF = Σ value × LT / Σ debt; limit = Σ value × LTV. */
export function summarizePosition(collaterals: CollateralPosition[], debtUsd: number): PositionSummary {
  let collateralUsd = 0;
  let borrowLimitUsd = 0;
  let adjustedCollateralUsd = 0;
  for (const c of collaterals) {
    collateralUsd += c.valueUsd;
    borrowLimitUsd += (c.valueUsd * c.ltvBps) / BPS;
    adjustedCollateralUsd += (c.valueUsd * c.ltBps) / BPS;
  }
  return {
    collateralUsd,
    borrowLimitUsd,
    adjustedCollateralUsd,
    debtUsd,
    healthFactor: debtUsd > 0 ? adjustedCollateralUsd / debtUsd : Infinity,
    availableUsd: Math.max(0, borrowLimitUsd - debtUsd),
    ltv: collateralUsd > 0 ? debtUsd / collateralUsd : 0,
  };
}

export type HealthTone = 'ok' | 'warn' | 'danger';
export const healthStatus = (hf: number): { label: 'Healthy' | 'Monitor' | 'At risk' | 'Liquidatable'; tone: HealthTone } => {
  if (hf >= 1.5) return { label: 'Healthy', tone: 'ok' };
  if (hf >= 1.2) return { label: 'Monitor', tone: 'warn' };
  if (hf >= 1) return { label: 'At risk', tone: 'danger' };
  return { label: 'Liquidatable', tone: 'danger' };
};

export const flashFee = (amount: number): number => (amount * FLASH_FEE_BPS) / BPS;

export type LoopPlan = {
  principal: number;
  leverage: number;
  flashAmount: number;
  fee: number;
  /** Gross supplied position (principal + flash amount). */
  gross: number;
  /** Debt opened by the loop (flash amount + fee). */
  debt: number;
  ltv: number;
  healthFactor: number;
  /** Max leverage allowed by the collateral LTV: 1 / (1 − LTV). */
  maxLeverage: number;
  /** Net APY on equity (fraction), using total supply yield and borrow rate. */
  netApy: number;
  /** Fractional fall in collateral value that would make the loop liquidatable. */
  liquidationBuffer: number;
  error: string | null;
};

/** Mirrors LeverageManager.loop: flash = principal × (L − 1); debt = flash + 9 bps fee. */
export function planLoop(principal: number, leverage: number, p: { ltvBps: number; ltBps: number; supplyApy: number; borrowApy: number }): LoopPlan {
  const flashAmount = principal * (leverage - 1);
  const fee = flashFee(flashAmount);
  const gross = principal + flashAmount;
  const debt = flashAmount + fee;
  const ltv = gross > 0 ? debt / gross : 0;
  const healthFactor = debt > 0 ? (gross * p.ltBps) / BPS / debt : Infinity;
  const maxLeverage = 1 / (1 - p.ltvBps / BPS);
  const netApy = principal > 0 ? (gross * p.supplyApy - debt * p.borrowApy) / principal : 0;
  const liquidationBuffer = Number.isFinite(healthFactor) ? Math.max(0, 1 - 1 / healthFactor) : 1;

  let error: string | null = null;
  if (!Number.isFinite(principal) || principal <= 0) error = 'Enter a valid amount';
  else if (leverage <= 1) error = 'Leverage must be above 1×';
  else if (ltv > p.ltvBps / BPS) error = `${leverage}× exceeds the ${(p.ltvBps / 100).toFixed(0)}% max LTV (max ≈ ${maxLeverage.toFixed(2)}×)`;
  return { principal, leverage, flashAmount, fee, gross, debt, ltv, healthFactor, maxLeverage, netApy, liquidationBuffer, error };
}

/** Collateral units seized for repaying `repay` (debt units) — VaultManager._seizeAmount. */
export function seizeAmount(repay: number, debtPrice: number, collateralPrice: number, bonusBps: number): number {
  return (repay * debtPrice * (BPS + bonusBps)) / BPS / collateralPrice;
}

/** Parses a user-entered amount; null for empty, non-numeric or non-positive input. */
export const parseAmount = (raw: string): number | null => {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};
