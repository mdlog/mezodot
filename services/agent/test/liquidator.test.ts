import { describe, expect, it } from 'vitest';
import { PRICE_KEYS, type PositionState, type ProtocolState } from '@mezodot/sdk';
import { evaluateAccount } from '../src/liquidator';

const E18 = 10n ** 18n;
const POOL_MUSD = '0x00000000000000000000000000000000000000a1';
const POOL_MEZO = '0x00000000000000000000000000000000000000a2';
const ALICE = '0x00000000000000000000000000000000000a11ce';

const market = (id: number, pool: `0x${string}`, symbol: 'MUSD' | 'MEZO') => ({
  id,
  symbol,
  receiptSymbol: `p${symbol}`,
  pool,
  asset: pool,
  decimals: 18,
  shareDecimals: 24,
  priceKey: PRICE_KEYS[symbol],
  totalAssets: 0n,
  totalBorrows: 0n,
  totalReserves: 0n,
  cash: 0n,
  totalSupply: 0n,
  exchangeRate: E18, // 1 share (1e24) = 1 underlying
  borrowRatePerSecond: 0n,
  supplyRatePerSecond: 0n,
  supplyCap: 0n,
  borrowCap: 0n,
});

const protocol: ProtocolState = {
  markets: [market(0, POOL_MUSD, 'MUSD'), market(1, POOL_MEZO, 'MEZO')],
  collaterals: [
    { id: 0, enabled: true, isRemote: false, token: POOL_MEZO, chainId: 0, remoteToken: '0x', decimals: 18, priceKey: PRICE_KEYS.MEZO, ltvBps: 5000, ltBps: 6000, bonusBps: 1000, cap: 0n, total: 0n, symbol: 'pMEZO' },
    { id: 1, enabled: true, isRemote: true, token: '0x0000000000000000000000000000000000000000', chainId: 10004, remoteToken: '0x', decimals: 18, priceKey: PRICE_KEYS.ETH, ltvBps: 7500, ltBps: 8000, bonusBps: 700, cap: 0n, total: 0n, symbol: 'WETH' },
  ],
  prices: {},
  keeperCount: 0n,
  blockNumber: 0n,
};

const position = (wethUnits: bigint, debtMusd: bigint, mezoShares = 0n): PositionState => ({
  account: ALICE,
  snapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: 0n, healthFactor: 0n },
  collateral: [
    { id: 0, balance: mezoShares, valueUsd: 0n },
    { id: 1, balance: wethUnits, valueUsd: 0n },
  ],
  debts: [
    { marketId: 0, amount: debtMusd },
    { marketId: 1, amount: 0n },
  ],
  isLeverageOperator: false,
});

describe('evaluateAccount', () => {
  it('healthy positions have no plan', () => {
    const e = evaluateAccount(protocol, position(E18, 2_000n * E18), { ETH: 3_200, MUSD: 1, MEZO: 0.008 });
    expect(e.healthFactor).toBeCloseTo((3_200 * 0.8) / 2_000, 9);
    expect(e.plan).toBeNull();
  });

  it('plans a 50% close-factor liquidation of remote wETH (CrossChain.t.sol numbers)', () => {
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1, MEZO: 0.008 });
    expect(e.healthFactor).toBeLessThan(1);
    expect(e.plan).not.toBeNull();
    const p = e.plan!;
    expect(p.collateralId).toBe(1);
    expect(p.isRemote).toBe(true);
    expect(p.repayAmount).toBe(1_175n * E18);
    expect(p.profitUsd).toBeCloseTo(1_175 * 0.07, 6);
    // minSeize = 98% of 1,175 × 1.07 / 2,800 wETH
    expect(Number(p.minSeize) / 1e18).toBeCloseTo(((1_175 * 1.07) / 2_800) * 0.98, 6);
  });

  it('caps repayment by keeper inventory', () => {
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1 }, { 0: 100n * E18 });
    expect(e.plan!.repayAmount).toBe(100n * E18);
  });

  it('scales down when collateral cannot cover the bonus', () => {
    const e = evaluateAccount(protocol, position(E18 / 10n, 2_350n * E18), { ETH: 2_800, MUSD: 1 });
    const p = e.plan!;
    expect(p.seizeUsd).toBeCloseTo(280, 6);
    expect(p.repayUsd).toBeCloseTo(280 / 1.07, 6);
  });

  it('values local pToken collateral via the exchange rate', () => {
    const shares = 1_000_000n * 10n ** 24n; // 1,000,000 MEZO worth of pMEZO
    const e = evaluateAccount(protocol, position(0n, 3_900n * E18, shares), { MEZO: 0.004764, MUSD: 1, ETH: 3_000 });
    expect(e.collateralUsd).toBeCloseTo(4_764, 6);
    expect(e.plan!.collateralId).toBe(0);
  });

  it('skips accounts when a price is unavailable', () => {
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { MUSD: 1 });
    expect(e.plan).toBeNull();
  });
});
