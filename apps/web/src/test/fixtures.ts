import { maxUint256, zeroHash, type Address } from 'viem';
import { PRICE_KEYS, type CollateralState, type MarketState, type PositionState, type ProtocolState } from '@mezodot/sdk';
import { MEZO_BTC } from '../lib/btc';

/**
 * A hub with the MUSD and MEZO pools, BTC, and WETH locked on Base Sepolia (Wormhole chain 10004), plus one account's
 * position in it. Values worth checking by hand are noted where they are set.
 */

export const E18 = 10n ** 18n;
/** One whole pToken share (24 decimals). */
export const SHARE = 10n ** 24n;
export const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';

const market = (patch: Partial<MarketState>): MarketState => ({
  id: 0,
  symbol: 'MUSD',
  receiptSymbol: 'pMUSD',
  pool: '0x00000000000000000000000000000000000000b1',
  asset: '0x00000000000000000000000000000000000000c1',
  decimals: 18,
  shareDecimals: 24,
  priceKey: PRICE_KEYS.MUSD,
  totalAssets: 10_000n * E18,
  totalBorrows: 4_000n * E18,
  totalReserves: 0n,
  cash: 6_000n * E18,
  totalSupply: 9_090n * SHARE,
  exchangeRate: E18,
  borrowRatePerSecond: 0n,
  supplyRatePerSecond: 0n,
  supplyCap: maxUint256,
  borrowCap: maxUint256,
  reserveFactor: E18 / 10n,
  ...patch,
});

/** 1 pMUSD = 1.1 MUSD. */
export const musd = market({ exchangeRate: 11n * 10n ** 17n });
export const mezo = market({
  id: 1,
  symbol: 'MEZO',
  receiptSymbol: 'pMEZO',
  pool: '0x00000000000000000000000000000000000000b2',
  asset: '0x00000000000000000000000000000000000000c2',
  priceKey: PRICE_KEYS.MEZO,
});

const collateral = (patch: Partial<CollateralState>): CollateralState => ({
  id: 0,
  enabled: true,
  isRemote: false,
  isShare: false,
  token: MEZO_BTC as Address,
  chainId: 0,
  remoteToken: zeroHash,
  decimals: 18,
  priceKey: PRICE_KEYS.BTC,
  ltvBps: 7_000,
  ltBps: 7_800,
  bonusBps: 500,
  cap: maxUint256,
  total: 0n,
  symbol: 'BTC',
  ...patch,
});

/** 1,000 pMUSD posted across the protocol: 1,100 MUSD. */
export const pMusd = collateral({
  id: 0,
  isShare: true,
  token: musd.pool,
  decimals: 24,
  priceKey: PRICE_KEYS.MUSD,
  ltvBps: 8_000,
  ltBps: 8_500,
  total: 1_000n * SHARE,
  symbol: 'pMUSD',
});
/** 2 BTC posted across the protocol. */
export const btc = collateral({ id: 1, total: 2n * E18 });
/** 3 WETH locked on Base Sepolia. */
export const weth = collateral({
  id: 2,
  isRemote: true,
  token: '0x00000000000000000000000000000000000000d1',
  chainId: 10_004,
  priceKey: PRICE_KEYS.ETH,
  ltvBps: 7_500,
  ltBps: 8_000,
  total: 3n * E18,
  symbol: 'WETH',
});

export const protocol: ProtocolState = {
  markets: [musd, mezo],
  collaterals: [pMusd, btc, weth],
  keeperCount: 1n,
  blockNumber: 1n,
  liquidationFeeBps: 1_000,
  treasury: ACCOUNT,
};

export const prices = { MUSD: 1, MEZO: 0.3, ETH: 3_000, USDC: 1, BTC: 60_000 };

/**
 * 100 pMUSD (110 MUSD, $110), 0.01 BTC ($600) and 0.5 WETH on Base ($1,500) posted: $2,210 of collateral, a $1,633
 * borrow limit (88 + 420 + 1,125) and $1,761.50 at liquidation thresholds (93.5 + 468 + 1,200). 500 MUSD borrowed:
 * health 1,761.5 / 500 = 3.52×.
 */
export const position: PositionState = {
  account: ACCOUNT,
  snapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: 0n, healthFactor: maxUint256 },
  collateral: [
    { id: 0, balance: 100n * SHARE, valueUsd: 0n },
    { id: 1, balance: E18 / 100n, valueUsd: 0n },
    { id: 2, balance: E18 / 2n, valueUsd: 0n },
  ],
  debts: [
    { marketId: 0, amount: 500n * E18 },
    { marketId: 1, amount: 0n },
  ],
  isLeverageOperator: false,
  isSwapLeverageOperator: false,
};

/** Rendered markup as a reader sees it: tags and React's text separators dropped, entities decoded, spaces collapsed. */
export const visibleText = (html: string): string =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
