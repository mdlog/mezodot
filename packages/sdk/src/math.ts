/**
 * Off-chain mirror of the contract formulas, for previews in the UI, agent and MCP tools.
 * Values use plain numbers (USD / token units), not wei. Test vectors in test/*.test.ts
 * match the Solidity tests so previews and on-chain results agree. Leverage previews: leverage.ts.
 */

export const BPS = 10_000;
export const SECONDS_PER_YEAR = 365 * 24 * 3600;
/** MezodotPool.FLASH_FEE_BPS */
export const FLASH_FEE_BPS = 9;
/** VaultManager.CLOSE_FACTOR_BPS */
export const CLOSE_FACTOR_BPS = 5_000;

export type RateModel = { base: number; slope1: number; kink: number; slope2: number };

/** Spec parameters (InterestRateModel constructor args as fractions). Live pools: MarketState.rateModel. */
export const RATE_MODELS = {
  MUSD: { base: 0, slope1: 0.06, kink: 0.8, slope2: 0.8 },
  MEZO: { base: 0.02, slope1: 0.08, kink: 0.7, slope2: 1.0 },
} as const satisfies Record<string, RateModel>;

/** Deployment default; the live, owner-set value (up to 30%) is MarketState.reserveFactor. */
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

/** Converts an on-chain per-second WAD rate to a simple annual rate (APR: rate × seconds, not compounded). */
export const perSecondToAnnual = (ratePerSecondWad: bigint): number => (Number(ratePerSecondWad) / 1e18) * SECONDS_PER_YEAR;

/**
 * Compounds a simple annual rate. Interest is added to debt and supply at every accrual (any pool interaction),
 * so over a year it compounds almost continuously: APY = e^APR − 1.
 */
export const aprToApy = (apr: number): number => Math.expm1(apr);

/** On-chain per-second WAD rate as an APY: what a position earns or pays over a year at that rate. */
export const perSecondToApy = (ratePerSecondWad: bigint): number => aprToApy(perSecondToAnnual(ratePerSecondWad));

// --- Pool state -----------------------------------------------------------------------------

/**
 * A lending pool in token units with its InterestRateModel and reserve factor: enough to price it at any
 * projected state (see `marketPoolState` for a live market). Caps default to none.
 */
export type PoolState = {
  cash: number;
  borrows: number;
  reserves: number;
  /** Share of borrower interest kept as reserves (0.1 = 10%). */
  reserveFactor: number;
  model: RateModel;
  supplyCap?: number;
  borrowCap?: number;
};

export type PoolRates = { utilization: number; borrowApy: number; supplyApy: number };

/** The pool's rates at `pool`, as its InterestRateModel computes them (borrowRatePerYear, supplyRatePerSecond), compounded to APYs. */
export function poolRates(pool: PoolState): PoolRates {
  const u = utilization(pool.cash, pool.borrows, pool.reserves);
  return { utilization: u, borrowApy: aprToApy(borrowRate(pool.model, u)), supplyApy: aprToApy(supplyRate(pool.model, u, pool.reserveFactor)) };
}

/** Supplied value, cash + borrows − reserves (MezodotPool.totalAssets). */
export const poolSupplied = (pool: Pick<PoolState, 'cash' | 'borrows' | 'reserves'>): number => Math.max(0, pool.cash + pool.borrows - pool.reserves);

/**
 * What the pool can still lend before its utilization passes `target` (e.g. its model's kink, past which rates
 * jump), within its idle cash and borrow cap. Lending moves cash into borrows, so supply stays the same.
 */
export const borrowRoomAt = (pool: PoolState, target: number): number =>
  Math.max(0, Math.min(pool.cash, (pool.borrowCap ?? Infinity) - pool.borrows, target * poolSupplied(pool) - pool.borrows));

// --- Positions ------------------------------------------------------------------------------

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

/** What VaultManager's checks read (USD): collateral, its LTV-weighted borrow limit, its LT-weighted value, and debt. */
export type AccountTotals = Pick<PositionSummary, 'collateralUsd' | 'borrowLimitUsd' | 'adjustedCollateralUsd' | 'debtUsd'>;

const summary = ({ collateralUsd, borrowLimitUsd, adjustedCollateralUsd, debtUsd }: AccountTotals): PositionSummary => ({
  collateralUsd,
  borrowLimitUsd,
  adjustedCollateralUsd,
  debtUsd,
  healthFactor: debtUsd > 0 ? adjustedCollateralUsd / debtUsd : Infinity,
  availableUsd: Math.max(0, borrowLimitUsd - debtUsd),
  ltv: collateralUsd > 0 ? debtUsd / collateralUsd : 0,
});

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
  return summary({ collateralUsd, borrowLimitUsd, adjustedCollateralUsd, debtUsd });
}

/** `account` after `add.collateralUsd` of new collateral (at its LTV and LT) and `add.debtUsd` of new debt. */
export function extendPosition(account: AccountTotals, add: { collateralUsd: number; ltvBps: number; ltBps: number; debtUsd: number }): PositionSummary {
  return summary({
    collateralUsd: account.collateralUsd + add.collateralUsd,
    borrowLimitUsd: account.borrowLimitUsd + (add.collateralUsd * add.ltvBps) / BPS,
    adjustedCollateralUsd: account.adjustedCollateralUsd + (add.collateralUsd * add.ltBps) / BPS,
    debtUsd: account.debtUsd + add.debtUsd,
  });
}

export type HealthTone = 'ok' | 'warn' | 'danger';
export const healthStatus = (hf: number): { label: 'Healthy' | 'Monitor' | 'At risk' | 'Liquidatable'; tone: HealthTone } => {
  if (hf >= 1.5) return { label: 'Healthy', tone: 'ok' };
  if (hf >= 1.2) return { label: 'Monitor', tone: 'warn' };
  if (hf >= 1) return { label: 'At risk', tone: 'danger' };
  return { label: 'Liquidatable', tone: 'danger' };
};

export const flashFee = (amount: number): number => (amount * FLASH_FEE_BPS) / BPS;

// --- Liquidations -----------------------------------------------------------------------------

/** Collateral units seized for repaying `repay` (debt units) — VaultManager._seizeAmount. */
export function seizeAmount(repay: number, debtPrice: number, collateralPrice: number, bonusBps: number): number {
  return (repay * debtPrice * (BPS + bonusBps)) / BPS / collateralPrice;
}

/** VaultManager.liquidate: the protocol keeps `liquidationFeeBps` of the bonus part of what is seized. */
export function liquidatorShare(seizedUnits: number, bonusBps: number, liquidationFeeBps: number): { toLiquidator: number; toProtocol: number } {
  const toProtocol = (((seizedUnits * bonusBps) / (BPS + bonusBps)) * liquidationFeeBps) / BPS;
  return { toLiquidator: seizedUnits - toProtocol, toProtocol };
}

/** Parses a user-entered amount; null for empty, non-numeric or non-positive input. */
export const parseAmount = (raw: string): number | null => {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};
