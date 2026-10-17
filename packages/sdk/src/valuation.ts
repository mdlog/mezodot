import { summarizePosition, type PositionSummary } from './math';
import { symbolForPriceKey, type CollateralState, type MarketState, type PositionState, type PriceSymbol, type ProtocolState } from './reader';

export type UsdPrices = Partial<Record<PriceSymbol, number>>;

export type ValuedCollateral = {
  collateral: CollateralState;
  balance: bigint;
  /** Underlying token units (pTokens converted through the exchange rate). */
  units: number;
  price: number;
  valueUsd: number;
};

export type ValuedDebt = { market: MarketState; amount: bigint; units: number; price: number; valueUsd: number };

export type ValuedPosition = PositionSummary & {
  collateral: ValuedCollateral[];
  debts: ValuedDebt[];
  /** USD value of collateral held on spokes (remote). */
  remoteCollateralUsd: number;
};

const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

/** Underlying units of a pToken balance. */
export const pTokenUnits = (market: MarketState, shares: bigint): number =>
  toNumber(shares, market.shareDecimals) * toNumber(market.exchangeRate, market.decimals);

/**
 * Values a position with off-chain (fresh) prices using the same rules as VaultManager:
 * pToken collateral through the exchange rate, remote collateral by token units.
 */
export function valuePosition(protocol: ProtocolState, position: PositionState, prices: UsdPrices): ValuedPosition {
  const collateral = protocol.collaterals.map((c): ValuedCollateral => {
    const balance = position.collateral.find((p) => p.id === c.id)?.balance ?? 0n;
    const symbol = symbolForPriceKey(c.priceKey);
    const price = symbol ? (prices[symbol] ?? 0) : 0;
    let units = 0;
    if (c.isRemote) units = toNumber(balance, c.decimals);
    else {
      const market = protocol.markets.find((m) => m.pool.toLowerCase() === c.token.toLowerCase());
      if (market) units = pTokenUnits(market, balance);
    }
    return { collateral: c, balance, units, price, valueUsd: units * price };
  });
  const debts = protocol.markets.map((m): ValuedDebt => {
    const amount = position.debts.find((d) => d.marketId === m.id)?.amount ?? 0n;
    const symbol = symbolForPriceKey(m.priceKey);
    const price = symbol ? (prices[symbol] ?? 0) : 0;
    const units = toNumber(amount, m.decimals);
    return { market: m, amount, units, price, valueUsd: units * price };
  });
  const summary = summarizePosition(
    collateral.filter((r) => r.balance > 0n).map((r) => ({ valueUsd: r.valueUsd, ltvBps: r.collateral.ltvBps, ltBps: r.collateral.ltBps })),
    debts.reduce((s, d) => s + d.valueUsd, 0),
  );
  return {
    ...summary,
    collateral,
    debts,
    remoteCollateralUsd: collateral.filter((r) => r.collateral.isRemote).reduce((s, r) => s + r.valueUsd, 0),
  };
}

/** Converts Hermes prices keyed by feed id into prices keyed by symbol. */
export function pricesBySymbol(feeds: Record<PriceSymbol, `0x${string}`>, byId: Record<string, { price: number }>): UsdPrices {
  const out: UsdPrices = {};
  for (const [symbol, id] of Object.entries(feeds) as [PriceSymbol, string][]) {
    const p = byId[id.toLowerCase()];
    if (p) out[symbol] = p.price;
  }
  return out;
}

/**
 * Units of collateral `collateralId` that can be withdrawn while keeping Σ value × LTV ≥ debt
 * (VaultManager's rule), with a 0.1% safety margin for price movement before inclusion.
 * Collateral without a usable price adds nothing to the limit and can always leave in full.
 */
export function maxWithdrawableUnits(valued: Pick<ValuedPosition, 'collateral' | 'debtUsd' | 'borrowLimitUsd'>, collateralId: number): number {
  const row = valued.collateral.find((c) => c.collateral.id === collateralId);
  if (!row || row.balance === 0n) return 0;
  if (valued.debtUsd <= 0 || row.price <= 0 || row.collateral.ltvBps === 0) return row.units;
  const headroomUsd = valued.borrowLimitUsd - valued.debtUsd;
  if (headroomUsd <= 0) return 0;
  const units = (headroomUsd / (row.price * (row.collateral.ltvBps / 10_000))) * 0.999;
  return Math.min(row.units, units);
}
