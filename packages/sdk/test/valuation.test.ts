import { describe, expect, it } from 'vitest';
import { maxUint256, type PublicClient } from 'viem';
import {
  INCLUSION_SECONDS,
  PRICE_KEYS,
  RATE_MODELS,
  borrowRoomAt,
  marketPoolState,
  maxBtcPrincipal,
  maxLoopPrincipal,
  maxWithdrawableUnits,
  pendingInterest,
  planBtcLeverage,
  planLoop,
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
    // What stays must back the $1,000 debt plus its 1% buffer: (2,250 − 1,010) / (3,000 × 0.75) WETH may leave.
    expect(maxWithdrawableUnits(v, 1)).toBeCloseTo((2_250 - 1_010) / (3_000 * 0.75), 12);
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

describe('valued accounts feed the leverage previews (final review sdk-loop-no-price-check)', () => {
  it('a loop for an account whose MUSD has no usable price is an error, as simulate_loop builds it', () => {
    // MUSD's push lapsed: valuePosition lists the MUSD debt as unpriced and the caller has no MUSD price to pass.
    const v = valuePosition(protocol, position, { ETH: 3_000 });
    const plan = planLoop(10, 3, { ltvBps: 8_000, ltBps: 8_500, account: v, musdPrice: undefined });
    expect(plan.error).toMatch(/^No usable MUSD price right now/);
    // With MUSD priced but MEZO debt unpriced, the strict debt pricing still blocks the borrow.
    const mezoDebt = { ...position, debts: [position.debts[0], { marketId: 1, amount: 10n * E18 }] };
    const w = valuePosition(protocol, mezoDebt, { ETH: 3_000, MUSD: 1 });
    expect(w.unpricedDebts).toEqual(['MEZO']);
    expect(planLoop(10, 3, { ltvBps: 8_000, ltBps: 8_500, account: w, musdPrice: 1 }).error).toMatch(/^No usable MEZO price for your debt/);
    expect(planBtcLeverage({ principal: 0.1, leverage: 2, btcPrice: 80_000, musdPrice: 1, ltvBps: 7_000, ltBps: 7_800, account: w }).error).toMatch(
      /^No usable MEZO price for your debt/,
    );
  });

  it('a withdrawal keeps 1% of the debt spare, so a small price move cannot revert it (sdk-unwind-margin-on-headroom)', () => {
    // 100 WETH at $1,000 ($75,000 limit) against $74,000: before, MAX left $1 of the limit spare (0.0014% of the debt).
    const weth: PositionState = { ...position, collateral: [position.collateral[0], { id: 1, balance: 100n * E18, valueUsd: 0n }] };
    const v = valuePosition(protocol, { ...weth, debts: [{ marketId: 0, amount: 74_000n * E18 }, position.debts[1]] }, { ETH: 1_000, MUSD: 1 });
    const max = maxWithdrawableUnits(v, 1);
    const limitLeft = v.borrowLimitUsd - max * 1_000 * 0.75;
    expect(limitLeft).toBeCloseTo(74_000 * 1.01, 6);
    // ETH 0.5% lower when the withdrawal lands still passes the check on what remains.
    expect(limitLeft * 0.995).toBeGreaterThan(74_000);
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

  it('includes the interest the pool accrues before it checks a cap (final review sdk-caps-ignore-pending-interest)', () => {
    const now = 1_800_000_000n;
    // MUSD at its 80% kink: 1,000,000 idle, 3,999,000 lent at 6% a year, last accrued 6 h ago, 4,000,000 borrow cap.
    const rate = 1_902_587_519n; // 6% / 31,536,000 s (WAD)
    const m: MarketState = {
      ...market(0, POOL_MUSD, 'MUSD'),
      cash: 1_000_000n * E18,
      totalBorrows: 3_999_000n * E18,
      borrowRatePerSecond: rate,
      borrowCap: 4_000_000n * E18,
      accrualTimestamp: now - 21_600n,
      rateModel: RATE_MODELS.MUSD,
    };
    // MezodotPool._accrued: simple interest at the stored rate, until the transaction lands INCLUSION_SECONDS later.
    const interest = (3_999_000n * E18 * rate * (21_600n + INCLUSION_SECONDS)) / E18;
    expect(pendingInterest(m, m.accrualTimestamp, now)).toBe(interest);
    const pool = marketPoolState(m, now)!;
    expect(pool.borrows).toBeCloseTo(Number(3_999_000n * E18 + interest) / 1e18, 6);
    expect(pool.borrows - 3_999_000).toBeCloseTo(168.9, 1);
    // The reserve factor's 10% of it goes to reserves, the rest to suppliers.
    expect(pool.reserves).toBeCloseTo(Number(interest) / 1e18 / 10, 6);

    // A 900 MUSD borrow fits the stored 3,999,000 but not the accrued total: MezodotPool.borrow reverts BorrowCapExceeded.
    const btc = { btcPrice: 80_000, musdPrice: 1, ltvBps: 7_000, ltBps: 7_800, pool };
    expect(planBtcLeverage({ ...btc, principal: 900 / 80_000, leverage: 2 }).error).toMatch(/borrow would pass the pool's borrow cap/);
    const room = 4_000_000 - pool.borrows;
    expect(maxBtcPrincipal(2, btc) * 80_000).toBeCloseTo(room, 6);
    expect(borrowRoomAt(pool, 1)).toBeCloseTo(room, 6);
    expect(planBtcLeverage({ ...btc, principal: (room * 0.99) / 80_000, leverage: 2 }).error).toBeNull();

    // The loop's deposit is checked against the accrued supply (PToken.maxDeposit): 300 MUSD of stored room is 148.
    const capped = marketPoolState({ ...m, borrowCap: maxUint256, supplyCap: (4_999_000n + 300n) * E18 }, now)!;
    const loop = { ltvBps: 8_000, ltBps: 8_500, pool: capped };
    const supplyRoom = 300 - (Number(interest) / 1e18) * 0.9;
    expect(maxLoopPrincipal(2, loop)).toBeCloseTo(supplyRoom / 2, 6);
    expect(planLoop(100, 2, loop).error).toMatch(/would pass the pool's supply cap/);
    expect(planLoop(70, 2, loop).error).toBeNull();
    // A hand-built state without a rate is unchanged; one without accrualTimestamp still allows for the inclusion window.
    expect(marketPoolState({ ...m, borrowRatePerSecond: 0n }, now)!.borrows).toBe(3_999_000);
    const window = (3_999_000n * E18 * rate * INCLUSION_SECONDS) / E18;
    expect(marketPoolState({ ...m, accrualTimestamp: undefined }, now)!.borrows).toBeCloseTo(Number(3_999_000n * E18 + window) / 1e18, 6);
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
