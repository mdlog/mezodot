import { maxUint256 } from 'viem';
import { BPS, summarizePosition, type PoolState, type PositionSummary } from './math';
import { symbolForPriceKey, type CollateralState, type MarketState, type PositionState, type PriceSymbol, type ProtocolState } from './reader';

export type UsdPrices = Partial<Record<PriceSymbol, number>>;

export type ValuedCollateral = {
  collateral: CollateralState;
  balance: bigint;
  /** Underlying token units (pTokens converted through the exchange rate; plain and remote tokens as held). */
  units: number;
  /** The usable price, else the fallback (last stored) price, else 0. */
  price: number;
  /** Value at `price`: what the collateral counts for toward health and in totals. */
  valueUsd: number;
  /**
   * Whether `price` is one VaultManager accepts now. Only then does the collateral add to the borrow limit: without
   * one it counts as zero there (conservative mode), and toward health at its fallback price, as the risk snapshot does.
   */
  priced: boolean;
};

export type ValuedDebt = {
  market: MarketState;
  amount: bigint;
  units: number;
  price: number;
  valueUsd: number;
  /** Whether `price` is one VaultManager accepts now; otherwise it is a fallback (or 0) and risk-checked calls revert. */
  priced: boolean;
};

/**
 * `borrowLimitUsd` and `availableUsd` follow VaultManager's borrow and withdraw checks (usable collateral prices only,
 * nothing while a debt is unpriced); value, health and LTV use every collateral at `price` (see ValuationOptions).
 */
export type ValuedPosition = PositionSummary & {
  collateral: ValuedCollateral[];
  debts: ValuedDebt[];
  /** USD value of collateral held on spokes (remote). */
  remoteCollateralUsd: number;
  /**
   * Symbols of debts without a usable price. VaultManager prices debt strictly, so while this is non-empty every
   * borrow, collateral withdrawal and loop reverts: `availableUsd` is 0 and nothing can be withdrawn.
   */
  unpricedDebts: PriceSymbol[];
};

export type ValuationOptions = {
  /**
   * Prices for held assets missing from `prices`, e.g. `displayPrices` (last stored values, as the on-chain risk
   * snapshot uses). A debt is valued at them (without one it counts as 0, which shows the account healthier than it
   * is), and so is collateral for value and health, while it still adds nothing to the borrow limit. Health then
   * matches the snapshot even when the same feed prices the collateral and the debt (a pMUSD loop when MUSD lapses).
   */
  fallbackPrices?: UsdPrices;
};

const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

/** Underlying units of a pToken balance. */
export const pTokenUnits = (market: MarketState, shares: bigint): number =>
  toNumber(shares, market.shareDecimals) * toNumber(market.exchangeRate, market.decimals);

/**
 * A market's pool in token units with its InterestRateModel, for rate projections; null when the model was not read.
 * Uncapped (type(uint256).max) caps become Infinity.
 */
export function marketPoolState(market: MarketState): PoolState | null {
  if (!market.rateModel) return null;
  const n = (v: bigint) => toNumber(v, market.decimals);
  const cap = (v: bigint) => (v === maxUint256 ? Infinity : n(v));
  return {
    cash: n(market.cash),
    borrows: n(market.totalBorrows),
    reserves: n(market.totalReserves),
    reserveFactor: Number(market.reserveFactor) / 1e18,
    model: market.rateModel,
    supplyCap: cap(market.supplyCap),
    borrowCap: cap(market.borrowCap),
  };
}

/**
 * Values a position using the same rules as VaultManager: pToken collateral through the exchange rate, plain hub
 * tokens (BTC) and remote collateral by token units. Pass `usablePrices(...)` so that collateral without an
 * acceptable price adds nothing to the borrow limit, as in VaultManager's conservative mode, and `opts.fallbackPrices`
 * to value everything without one at its last stored price. Disabled collateral adds nothing to the borrow limit but
 * keeps its liquidation threshold for health. Debts without a usable price are listed in `unpricedDebts`.
 */
export function valuePosition(protocol: ProtocolState, position: PositionState, prices: UsdPrices, opts: ValuationOptions = {}): ValuedPosition {
  const priceOf = (key: CollateralState['priceKey']) => {
    const symbol = symbolForPriceKey(key);
    const usable = symbol ? prices[symbol] : undefined;
    return { price: usable ?? (symbol ? (opts.fallbackPrices?.[symbol] ?? 0) : 0), priced: usable !== undefined };
  };
  const collateral = protocol.collaterals.map((c): ValuedCollateral => {
    const balance = position.collateral.find((p) => p.id === c.id)?.balance ?? 0n;
    const { price, priced } = priceOf(c.priceKey);
    let units = 0;
    if (!c.isShare) units = toNumber(balance, c.decimals);
    else {
      const market = protocol.markets.find((m) => m.pool.toLowerCase() === c.token.toLowerCase());
      if (market) units = pTokenUnits(market, balance);
    }
    return { collateral: c, balance, units, price, valueUsd: units * price, priced };
  });
  const debts = protocol.markets.map((m): ValuedDebt => {
    const amount = position.debts.find((d) => d.marketId === m.id)?.amount ?? 0n;
    const { price, priced } = priceOf(m.priceKey);
    const units = toNumber(amount, m.decimals);
    return { market: m, amount, units, price, valueUsd: units * price, priced };
  });
  const summary = summarizePosition(
    collateral
      .filter((r) => r.balance > 0n)
      .map((r) => ({ valueUsd: r.valueUsd, ltvBps: r.collateral.enabled === false ? 0 : r.collateral.ltvBps, ltBps: r.collateral.ltBps })),
    debts.reduce((s, d) => s + d.valueUsd, 0),
  );
  // VaultManager's limit counts only collateral it can price now (and that is enabled).
  const borrowLimitUsd = collateral.reduce(
    (s, r) => (r.balance > 0n && r.priced && r.collateral.enabled !== false ? s + (r.valueUsd * r.collateral.ltvBps) / BPS : s),
    0,
  );
  const unpricedDebts = debts
    .filter((d) => d.amount > 0n && !d.priced)
    .map((d) => symbolForPriceKey(d.market.priceKey))
    .filter((s): s is PriceSymbol => s !== undefined);
  // A debt without an accepted price fails every risk check, so nothing more can be borrowed (this also covers a
  // market whose price key the SDK cannot name in `unpricedDebts`).
  const blocked = debts.some((d) => d.amount > 0n && !d.priced);
  return {
    ...summary,
    borrowLimitUsd,
    availableUsd: blocked ? 0 : Math.max(0, borrowLimitUsd - summary.debtUsd),
    collateral,
    debts,
    remoteCollateralUsd: collateral.filter((r) => r.collateral.isRemote).reduce((s, r) => s + r.valueUsd, 0),
    unpricedDebts,
  };
}

/**
 * Units of collateral `collateralId` that can be withdrawn while keeping Σ value × LTV ≥ debt
 * (VaultManager's rule), with a 0.1% safety margin for price movement before inclusion.
 * Collateral without a usable price, or disabled, adds nothing to the limit: it can leave in full while the rest
 * covers the debt, and not at all otherwise (the check runs on what remains). With a debt that has no usable price
 * nothing can leave (the risk check reverts).
 */
export function maxWithdrawableUnits(
  valued: Pick<ValuedPosition, 'collateral' | 'debtUsd' | 'borrowLimitUsd'> & Partial<Pick<ValuedPosition, 'unpricedDebts' | 'debts'>>,
  collateralId: number,
): number {
  const row = valued.collateral.find((c) => c.collateral.id === collateralId);
  if (!row || row.balance === 0n) return 0;
  const hasDebt = valued.debts ? valued.debts.some((d) => d.amount > 0n) : valued.debtUsd > 0;
  if (!hasDebt) return row.units;
  if ((valued.unpricedDebts?.length ?? 0) > 0 || valued.debts?.some((d) => d.amount > 0n && d.priced === false)) return 0;
  const ltvBps = row.collateral.enabled === false ? 0 : row.collateral.ltvBps;
  const headroomUsd = valued.borrowLimitUsd - valued.debtUsd;
  if (row.priced === false || row.price <= 0 || ltvBps === 0) return headroomUsd >= 0 ? row.units : 0;
  if (headroomUsd <= 0) return 0;
  const units = (headroomUsd / (row.price * (ltvBps / BPS))) * 0.999;
  return Math.min(row.units, units);
}
