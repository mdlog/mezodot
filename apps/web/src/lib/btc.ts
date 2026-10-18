/**
 * Mezo's BTC is the gas token and, at the same time, an ERC-20 precompile at this address (same balance).
 * Spending all of it as collateral or leverage principal would leave nothing to pay for the next transaction.
 */
export const MEZO_BTC = '0x7b7c000000000000000000000000000000000000';

/** BTC kept back for gas whenever an action spends the wallet's BTC (0.0002 BTC: hundreds of Mezo transactions). */
export const BTC_GAS_RESERVE = 200_000_000_000_000n;

export const isGasToken = (token: string): boolean => token.toLowerCase() === MEZO_BTC;

/** BTC the wallet can commit while keeping the gas reserve. */
export const spendableBtc = (balance: bigint): bigint => (balance > BTC_GAS_RESERVE ? balance - BTC_GAS_RESERVE : 0n);
