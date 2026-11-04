// What the demo wallet does on camera, and what it must hold for that. The narration reads its numbers from here, so
// changing an amount changes what the voice says.

export const PLAN = {
  trove: { btc: '0.05', musd: '2000' },
  borrowMezo: '20',
  btcLong: { btc: '0.0015', leverage: 2 },
  /** Already credited on the hub: the WETH this wallet locked on Base Sepolia for the Wave 1 take. Filmed, not sent. */
  lockedWeth: '0.002',
  /** Targets the demo wallet is topped up to. A trove needs more BTC than the deployer holds: see README.md. */
  fund: { btc: '0.056', musd: '6' },
};
