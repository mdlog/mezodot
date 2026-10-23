import type { Hex } from 'viem';
import { pTokenUnits, symbolForPriceKey, type CollateralState, type ProtocolState, type UsdPrices } from '@mezodot/sdk';

/** Protocol totals in USD. */
export type ProtocolTotals = {
  /**
   * Value locked, net of borrows (DefiLlama style): idle pool cash (deposits not lent out, plus reserves), plain hub
   * collateral (BTC in VaultManager custody) and collateral locked on spokes. Borrowed MUSD has left the protocol and
   * looped supply is the same MUSD lent back, so neither counts; pToken collateral is a claim on pool supply.
   */
  tvl: number;
  /** Pool supply (cash + borrows − reserves): looped supply counts in full. */
  supplied: number;
  borrowed: number;
};

export function protocolTotals(protocol: ProtocolState, prices: UsdPrices): ProtocolTotals {
  const priceOf = (key: Hex) => {
    const symbol = symbolForPriceKey(key);
    return symbol ? (prices[symbol] ?? 0) : 0;
  };
  let tvl = 0;
  let supplied = 0;
  let borrowed = 0;
  for (const m of protocol.markets) {
    const usd = (v: bigint) => (Number(v) / 10 ** m.decimals) * priceOf(m.priceKey);
    tvl += usd(m.cash);
    supplied += usd(m.totalAssets);
    borrowed += usd(m.totalBorrows);
  }
  for (const c of protocol.collaterals) {
    if (!c.isShare) tvl += (Number(c.total) / 10 ** c.decimals) * priceOf(c.priceKey);
  }
  return { tvl, supplied, borrowed };
}

/** One collateral type and what every account has posted of it, in underlying units and USD. */
export type CollateralTotal = { collateral: CollateralState; units: number; valueUsd: number };

/** Collateral posted across the protocol: pTokens through their pool's exchange rate, BTC and spoke tokens as held. */
export function collateralTotals(protocol: ProtocolState, prices: UsdPrices): CollateralTotal[] {
  return protocol.collaterals.map((c) => {
    const market = c.isShare ? protocol.markets.find((m) => m.pool.toLowerCase() === c.token.toLowerCase()) : undefined;
    const units = c.isShare ? (market ? pTokenUnits(market, c.total) : 0) : Number(c.total) / 10 ** c.decimals;
    const symbol = symbolForPriceKey(c.priceKey);
    return { collateral: c, units, valueUsd: units * (symbol ? (prices[symbol] ?? 0) : 0) };
  });
}
