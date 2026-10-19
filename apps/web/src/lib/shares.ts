import type { MarketState } from '@mezodot/sdk';

type Rate = Pick<MarketState, 'shareDecimals' | 'exchangeRate'>;

/** Underlying → pToken shares through the exchange rate (bigint, floor). */
export const sharesFor = (m: Rate, assets: bigint): bigint => (assets * 10n ** BigInt(m.shareDecimals)) / (m.exchangeRate || 1n);

/** pToken shares → underlying through the exchange rate (bigint, floor). */
export const assetsFor = (m: Rate, shares: bigint): bigint => (shares * m.exchangeRate) / 10n ** BigInt(m.shareDecimals);
