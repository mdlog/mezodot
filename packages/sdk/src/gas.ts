/**
 * Gas limits from node estimates. Mezo's eth_estimateGas can be exact to the unit, and the block that executes the
 * transaction may need slightly more (interest accrual writes depend on when it lands): on Mezo testnet a redeem
 * estimated at 77,882 gas ran out at 77,823. Some Mezo RPC backends also estimate as if no contract code ran
 * (~24k–31k, intrinsic plus calldata), so calls with a known cost take a floor as well.
 */

/**
 * Minimum gas limits per call type, from usage measured on Mezo testnet (2026-10-18). Pass one as the `floor` of
 * `gasWithBuffer` whenever the call is of that type; when several apply, use the largest.
 */
export const GAS_FLOOR = {
  /** OracleRouter.updatePrices with one Pyth update (~130k used; reverted pushes had ~60k limits). Per update. */
  pythUpdate: 200_000n,
  /** KeeperGateway.relayMessage / SpokeGateway.receiveMessage with a guardian-signed VAA (~163k used). */
  vaaRelay: 250_000n,
  /** Any risk-checked call that carries a Supra DORA proof: borrow, withdraw, liquidation (~1M used). */
  supraProof: 1_200_000n,
  /** VaultManager.liquidate through KeeperGateway without a Supra proof (strict valuation of every holding). */
  liquidation: 700_000n,
  /** ERC-20 approve. */
  erc20Approve: 80_000n,
  /** pToken (ERC-4626) deposit, withdraw or redeem: interest accrual plus the share transfer. */
  poolRedeem: 150_000n,
  /** Single-hop Tigris swap through the router. */
  dexSwap: 250_000n,
} as const;

export type GasFloorName = keyof typeof GAS_FLOOR;

/** Gas limit for a node estimate: max(floor, estimate × 1.3 + 20k). */
export const gasWithBuffer = (estimate: bigint, floor = 0n): bigint => {
  const buffered = (estimate * 13n) / 10n + 20_000n;
  return buffered > floor ? buffered : floor;
};
