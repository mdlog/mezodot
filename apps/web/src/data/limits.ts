import { formatUnits } from 'viem';
import { WITHDRAW_BUFFER_BPS, type CollateralState, type MarketState, type ValuedPosition } from '@mezodot/sdk';
import { BTC_GAS_RESERVE, isGasToken, spendableBtc } from '../lib/btc';
import { assetsFor } from '../lib/shares';
import { borrowRoom, collateralRoom, supplyRoom } from './guards';

/**
 * MAX amounts of the hub action forms, in exact base units, each with the limit that sets it so an amount above it is
 * refused with that limit named. The caps come from guards.ts, where maxUint256 means uncapped (the other bound then
 * always wins).
 */

/** The most an action accepts, and what sets it (it completes "Amount exceeds …"). */
export type Bound = { max: bigint; limit: string };

/** The tightest bound; on a tie the first one passed names the limit. */
export const tightest = (first: Bound, ...rest: Bound[]): Bound => rest.reduce((a, b) => (b.max < a.max ? b : a), first);

/** Supplying: the wallet balance, within what the pool still accepts under its supply cap (PToken.maxDeposit). */
export const supplyBound = (
  m: Pick<MarketState, 'symbol' | 'supplyCap' | 'totalAssets'> & Partial<Pick<MarketState, 'totalBorrows' | 'borrowRatePerSecond'>>,
  wallet: bigint,
): Bound =>
  tightest(
    { max: wallet, limit: `your ${m.symbol} wallet balance` },
    { max: supplyRoom(m), limit: `what the ${m.symbol} pool still accepts under its supply cap` },
  );

/** Borrowing: the account's headroom at fresh prices, within the pool's idle cash and its borrow cap (MezodotPool.borrow). */
export const borrowBound = (
  m: Pick<MarketState, 'symbol' | 'cash' | 'borrowCap' | 'totalBorrows'> & Partial<Pick<MarketState, 'borrowRatePerSecond' | 'accrualTimestamp'>>,
  headroom: bigint,
): Bound =>
  tightest(
    { max: headroom, limit: 'your borrow limit' },
    { max: m.cash, limit: "the pool's available liquidity" },
    { max: borrowRoom(m), limit: `what the ${m.symbol} pool can still lend under its borrow cap` },
  );

/**
 * Posting pool shares (pMUSD, pMEZO): the wallet's shares within the collateral cap, which VaultManager counts in
 * shares. `max` is their value in underlying (the unit the form takes), `shares` exactly what MAX posts: every share
 * in the wallet, or the room left under the cap.
 */
export function sharePostBound(
  m: Pick<MarketState, 'receiptSymbol' | 'exchangeRate' | 'shareDecimals'>,
  c: Pick<CollateralState, 'symbol' | 'cap' | 'total'>,
  walletShares: bigint,
): Bound & { shares: bigint } {
  const room = collateralRoom(c);
  const capped = room < walletShares;
  const shares = capped ? room : walletShares;
  // assetsFor floors, so any amount up to `max` converts back (sharesFor, also floored) to at most `shares`.
  return { shares, max: assetsFor(m, shares), limit: capped ? `what ${c.symbol} collateral still accepts under its cap` : `your ${m.receiptSymbol} balance` };
}

/**
 * Posting a plain token (Mezo's BTC): the wallet balance, less the gas reserve when the token is also the gas token,
 * within the collateral cap (token units).
 */
export function tokenPostBound(c: Pick<CollateralState, 'symbol' | 'token' | 'decimals' | 'cap' | 'total'>, held: bigint): Bound {
  const wallet: Bound = isGasToken(c.token)
    ? { max: spendableBtc(held), limit: `your ${c.symbol} wallet balance (keeping ${exactUnits(BTC_GAS_RESERVE, c.decimals)} ${c.symbol} for gas)` }
    : { max: held, limit: `your ${c.symbol} wallet balance` };
  return tightest(wallet, { max: collateralRoom(c), limit: `what ${c.symbol} collateral still accepts under its cap` });
}

/** Base units as exact decimal text with grouped digits (1,234.000001): a limit rounded for display could read above itself. */
export function exactUnits(value: bigint, decimals: number): string {
  const [whole, fraction] = formatUnits(value, decimals).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}

/** Base units cut (never rounded) to `digits` fraction digits: a MAX label must not read above the real MAX. */
export function truncatedUnits(value: bigint, decimals: number, digits: number): string {
  const [whole, fraction] = exactUnits(value, decimals).split('.');
  const cut = fraction?.slice(0, digits).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

/**
 * USD the account can still borrow, keeping WITHDRAW_BUFFER_BPS of its borrow limit spare: prices can move between
 * the preview and inclusion, and a borrow sized to end exactly at the limit reverts on the smallest move, however
 * large the debt. Zero whenever VaultManager would refuse any borrow (availableUsd is 0 then).
 */
export function borrowHeadroomUsd(v: Pick<ValuedPosition, 'borrowLimitUsd' | 'debtUsd' | 'availableUsd'> | null | undefined): number {
  if (!v || v.availableUsd <= 0) return 0;
  return Math.max(0, v.borrowLimitUsd / (1 + WITHDRAW_BUFFER_BPS / 10_000) - v.debtUsd);
}
