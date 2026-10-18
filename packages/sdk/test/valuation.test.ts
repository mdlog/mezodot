import { describe, expect, it } from 'vitest';
import { maxUint256, type PublicClient } from 'viem';
import {
  PRICE_KEYS,
  RATE_MODELS,
  marketPoolState,
  maxWithdrawableUnits,
  readRateModel,
  valuePosition,
  type CollateralState,
  type MarketState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '../src';

const E18 = 10n ** 18n;
const POOL_MUSD = '0x00000000000000000000000000000000000000a1';
const POOL_MEZO = '0x00000000000000000000000000000000000000a2';

const market = (id: number, pool: `0x${string}`, symbol: 'MUSD' | 'MEZO'): MarketState => ({
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
  supplyCap: maxUint256,
  borrowCap: maxUint256,
  reserveFactor: E18 / 10n,
});

const collateral = (id: number, symbol: string, price: PriceSymbol, c: Partial<CollateralState>): CollateralState => ({
  id,
  enabled: true,
  isRemote: false,
  isShare: false,
  token: '0x0000000000000000000000000000000000000000',
  chainId: 0,
  remoteToken: '0x',
  decimals: 18,
  priceKey: PRICE_KEYS[price],
  ltvBps: 7_500,
  ltBps: 8_000,
  bonusBps: 700,
  cap: 0n,
  total: 0n,
  symbol,
  ...c,
});

const protocol: ProtocolState = {
  markets: [market(0, POOL_MUSD, 'MUSD'), market(1, POOL_MEZO, 'MEZO')],
  collaterals: [
    collateral(0, 'pMUSD', 'MUSD', { isShare: true, token: POOL_MUSD, ltvBps: 8_000, ltBps: 8_500 }),
    collateral(1, 'WETH', 'ETH', { isRemote: true, chainId: 10004 }),
  ],
  keeperCount: 0n,
  blockNumber: 0n,
  liquidationFeeBps: 1_000,
  treasury: '0x0000000000000000000000000000000000000000',
};

/** 1 WETH posted against 1,000 MUSD of debt. */
const position: PositionState = {
  account: '0x00000000000000000000000000000000000a11ce',
  snapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: 0n, healthFactor: 0n },
  collateral: [
    { id: 0, balance: 0n, valueUsd: 0n },
    { id: 1, balance: E18, valueUsd: 0n },
  ],
  debts: [
    { marketId: 0, amount: 1_000n * E18 },
    { marketId: 1, amount: 0n },
  ],
  isLeverageOperator: false,
  isSwapLeverageOperator: false,
};

describe('valuation with a debt that has no usable price (audit: unpriced debt valued at $0)', () => {
  it('lists the debt, values it at the last stored price and blocks borrowing and withdrawals', () => {
    // MUSD's Pyth feed lapsed: no usable MUSD price, last stored value 0.99.
    const v = valuePosition(protocol, position, { ETH: 3_000 }, { fallbackPrices: { MUSD: 0.99, ETH: 3_000 } });
    expect(v.unpricedDebts).toEqual(['MUSD']);
    expect(v.debts[0]).toMatchObject({ price: 0.99, priced: false });
    expect(v.debtUsd).toBeCloseTo(990, 9);
    // Health stays honest (not "no debt"), but every risk-checked action would revert.
    expect(v.healthFactor).toBeCloseTo((3_000 * 0.8) / 990, 9);
    expect(v.availableUsd).toBe(0);
    expect(maxWithdrawableUnits(v, 1)).toBe(0);
  });

  it('still lists the debt without a fallback price (valued at 0, as before)', () => {
    const v = valuePosition(protocol, position, { ETH: 3_000 });
    expect(v.unpricedDebts).toEqual(['MUSD']);
    expect(v.debtUsd).toBe(0);
    expect(v.availableUsd).toBe(0);
    expect(maxWithdrawableUnits(v, 1)).toBe(0);
  });

  it('a priced debt keeps the usual limits', () => {
    const v = valuePosition(protocol, position, { ETH: 3_000, MUSD: 1 }, { fallbackPrices: { MUSD: 0.5 } });
    expect(v.unpricedDebts).toEqual([]);
    expect(v.debts[0]).toMatchObject({ price: 1, priced: true });
    expect(v.availableUsd).toBeCloseTo(2_250 - 1_000, 9);
    expect(maxWithdrawableUnits(v, 1)).toBeCloseTo((1_250 / (3_000 * 0.75)) * 0.999, 12);
  });

  it('a debt-free account can withdraw everything without any price', () => {
    const free = { ...position, debts: position.debts.map((d) => ({ ...d, amount: 0n })) };
    expect(maxWithdrawableUnits(valuePosition(protocol, free, {}), 1)).toBe(1);
  });

  it('values a pMUSD loop at the last MUSD price on both sides when the feed lapses, as the risk snapshot does', () => {
    // 3,000 MUSD of pMUSD against 2,001.8 MUSD of debt; no usable MUSD price, last stored 0.99.
    const loop: PositionState = {
      ...position,
      collateral: [
        { id: 0, balance: 3_000n * 10n ** 24n, valueUsd: 0n },
        { id: 1, balance: 0n, valueUsd: 0n },
      ],
      debts: [
        { marketId: 0, amount: 2_001_800n * 10n ** 15n },
        { marketId: 1, amount: 0n },
      ],
    };
    const v = valuePosition(protocol, loop, {}, { fallbackPrices: { MUSD: 0.99 } });
    // Neither "no debt" (debt at 0) nor liquidatable (collateral at 0): HF 3,000 × 0.85 / 2,001.8.
    expect(v.healthFactor).toBeCloseTo((3_000 * 0.85) / 2_001.8, 9);
    expect(v.collateral[0]).toMatchObject({ price: 0.99, priced: false });
    expect(v.collateralUsd).toBeCloseTo(2_970, 9);
    // The limit follows VaultManager's conservative mode: unpriced collateral adds nothing, and the unpriced debt blocks.
    expect(v.borrowLimitUsd).toBe(0);
    expect(v.availableUsd).toBe(0);
    expect(v.unpricedDebts).toEqual(['MUSD']);
  });
});

describe('collateral without a usable price, against a priced debt', () => {
  // WETH needs a Supra proof the relay cannot supply right now; last stored ETH 3,000. MUSD priced at 1.
  it('counts toward value and health at its last price but adds nothing to the limit', () => {
    const v = valuePosition(protocol, position, { MUSD: 1 }, { fallbackPrices: { ETH: 3_000 } });
    expect(v.collateral[1]).toMatchObject({ price: 3_000, priced: false, valueUsd: 3_000 });
    expect(v.healthFactor).toBeCloseTo(2.4, 9);
    expect(v.borrowLimitUsd).toBe(0);
    expect(v.availableUsd).toBe(0);
    // Withdrawing it leaves the limit unchanged, but the check runs on what remains: 0 < 1,000 of debt reverts.
    expect(maxWithdrawableUnits(v, 1)).toBe(0);
    // Without fallback prices it is valued at 0, as before.
    expect(valuePosition(protocol, position, { MUSD: 1 }).healthFactor).toBe(0);
  });

  it('can leave in full while priced collateral covers the debt', () => {
    // 2,000 MUSD of pMUSD (limit $1,600) carries the $1,000 debt on its own.
    const withPmusd: PositionState = { ...position, collateral: [{ id: 0, balance: 2_000n * 10n ** 24n, valueUsd: 0n }, position.collateral[1]] };
    const v = valuePosition(protocol, withPmusd, { MUSD: 1 }, { fallbackPrices: { ETH: 3_000 } });
    expect(v.borrowLimitUsd).toBeCloseTo(1_600, 9);
    expect(maxWithdrawableUnits(v, 1)).toBe(1);
  });
});

describe('disabled collateral (VaultManager: no borrowing power, health unchanged)', () => {
  const disabled: ProtocolState = { ...protocol, collaterals: [protocol.collaterals[0], { ...protocol.collaterals[1], enabled: false }] };

  it('adds nothing to the borrow limit but keeps its liquidation threshold', () => {
    const v = valuePosition(disabled, position, { ETH: 3_000, MUSD: 1 });
    expect(v.borrowLimitUsd).toBe(0);
    expect(v.adjustedCollateralUsd).toBeCloseTo(2_400, 9);
    expect(v.healthFactor).toBeCloseTo(2.4, 9);
    expect(v.availableUsd).toBe(0);
    // The withdrawal check runs on what remains: a 0 limit under 1,000 of debt reverts, whatever is withdrawn.
    expect(maxWithdrawableUnits(v, 1)).toBe(0);
    // Once other collateral covers the debt, the disabled one can leave in full (it backs no borrowing).
    expect(maxWithdrawableUnits({ ...v, borrowLimitUsd: 1_000 }, 1)).toBe(1);
  });
});

describe('pool state for rate projections', () => {
  it('converts a market to token units, with uncapped caps as Infinity', () => {
    const m: MarketState = {
      ...market(0, POOL_MUSD, 'MUSD'),
      cash: 109_340n * 10n ** 15n,
      totalBorrows: 1_830n * 10n ** 15n,
      totalReserves: 167n * 10n ** 15n,
      borrowCap: 500n * E18,
      reserveFactor: 2n * 10n ** 17n,
      rateModel: RATE_MODELS.MUSD,
    };
    expect(marketPoolState(m)).toEqual({
      cash: 109.34,
      borrows: 1.83,
      reserves: 0.167,
      reserveFactor: 0.2,
      model: RATE_MODELS.MUSD,
      supplyCap: Infinity,
      borrowCap: 500,
    });
    expect(marketPoolState(market(0, POOL_MUSD, 'MUSD'))).toBeNull();
  });

  it('reads a pool rate model once per client (the model and its parameters are immutable)', async () => {
    const calls: string[] = [];
    const IRM = '0x00000000000000000000000000000000000000f1';
    const values: Record<string, bigint> = { baseRatePerYear: 0n, slope1PerYear: 6n * 10n ** 16n, kink: 8n * 10n ** 17n, slope2PerYear: 8n * 10n ** 17n };
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        return functionName === 'interestRateModel' ? IRM : values[functionName];
      },
    } as unknown as PublicClient;
    expect(await readRateModel(client, POOL_MUSD)).toEqual(RATE_MODELS.MUSD);
    expect(await readRateModel(client, POOL_MUSD.toUpperCase().replace('0X', '0x') as `0x${string}`)).toEqual(RATE_MODELS.MUSD);
    expect(calls).toHaveLength(5);
    // A failed read is not cached.
    let fail = true;
    const flaky = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (fail) throw new Error('rpc');
        return functionName === 'interestRateModel' ? IRM : values[functionName];
      },
    } as unknown as PublicClient;
    await expect(readRateModel(flaky, POOL_MEZO)).rejects.toThrow('rpc');
    fail = false;
    expect(await readRateModel(flaky, POOL_MEZO)).toEqual(RATE_MODELS.MUSD);
  });
});
