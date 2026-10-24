import type { CollateralState, ProtocolState } from '@mezodot/sdk';

const BPS = 10_000;

export type BorrowSimulation = {
  valueUsd: number;
  /** MUSD the collateral can back at its LTV. */
  limitMusd: number;
  borrowMusd: number;
  /** Value at the liquidation threshold over debt; Infinity without debt. */
  healthFactor: number;
  /** Collateral price at which the position becomes liquidatable; null without debt. */
  liquidationPrice: number | null;
};

/**
 * A fresh position that posts `amount` of one collateral and borrows `share` of its MUSD limit, priced as VaultManager
 * prices it: limit = value × LTV, health = value × liquidation threshold / debt. MUSD counts at its own price.
 */
export function simulateBorrow({
  amount,
  price,
  ltvBps,
  ltBps,
  musdPrice,
  share,
}: {
  amount: number;
  price: number;
  ltvBps: number;
  ltBps: number;
  musdPrice: number;
  share: number;
}): BorrowSimulation {
  const valueUsd = amount * price;
  const limitMusd = musdPrice > 0 ? (valueUsd * ltvBps) / BPS / musdPrice : 0;
  const borrowMusd = limitMusd * Math.min(1, Math.max(0, share));
  const debtUsd = borrowMusd * musdPrice;
  if (debtUsd <= 0) return { valueUsd, limitMusd, borrowMusd: 0, healthFactor: Infinity, liquidationPrice: null };
  return {
    valueUsd,
    limitMusd,
    borrowMusd,
    healthFactor: (valueUsd * ltBps) / BPS / debtUsd,
    liquidationPrice: debtUsd / ((amount * ltBps) / BPS),
  };
}

/** The collateral the hub accepts from one spoke (its Wormhole chain id) for a token symbol. */
export const spokeCollateral = (protocol: ProtocolState, wormholeChainId: number, symbol: string): CollateralState | undefined =>
  protocol.collaterals.find((c) => c.isRemote && c.chainId === wormholeChainId && c.symbol === symbol);
