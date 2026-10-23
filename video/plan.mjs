// What the demo wallet does on camera, and what it must hold for that (with a retake's worth of margin). The
// narration reads its numbers from here, so changing an amount changes what the voice says.

export const PLAN = {
  supplyMusd: '2',
  loop: { principalMusd: '2', leverage: 3 },
  btcLong: { btc: '0.0015', leverage: 2 },
  lockWeth: '0.002',
  /** Targets the demo wallet is topped up to from the deployer keystore. */
  fund: { btc: '0.004', musd: '6', baseEth: '0.004' },
};
