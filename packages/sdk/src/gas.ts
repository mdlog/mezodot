/**
 * Gas limit for a transaction from a node estimate: +30% plus 20k. Mezo's eth_estimateGas can be exact to
 * the unit, and the block that executes the transaction may need slightly more (interest accrual writes
 * depend on when it lands): on Mezo testnet a redeem estimated at 77,882 gas ran out at 77,823.
 */
export const gasWithBuffer = (estimate: bigint): bigint => (estimate * 13n) / 10n + 20_000n;
