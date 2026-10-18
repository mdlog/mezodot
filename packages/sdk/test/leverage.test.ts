import { describe, expect, it } from 'vitest';
import {
  RATE_MODELS,
  aprToApy,
  borrowRate,
  borrowRoomAt,
  liquidatorShare,
  maxBtcPrincipal,
  maxLoopPrincipal,
  planBtcClose,
  planBtcLeverage,
  planLoop,
  planUnwind,
  supplyRate,
  utilization,
  type PoolState,
} from '../src';

const BTC = { btcPrice: 80_000, musdPrice: 1, ltvBps: 7_000, ltBps: 7_800 };
/** Tigris volatile pool output with its fee on the input (MockTigrisPool.getAmountOut). */
const quoteOut = (amountIn: number, reserveIn: number, reserveOut: number, feeBps = 4) => {
  const net = amountIn * (1 - feeBps / 10_000);
  return (net * reserveOut) / (reserveIn + net);
};

describe('BTC leverage preview (SwapLeverageManager flash swap)', () => {
  it('mirrors the contract test: 1 BTC to 2.5x, debt exactly the borrow (no flash fee)', () => {
    // SwapLeverageManager.t.sol: a deep pool at 80,000 MUSD per BTC (80M MUSD / 1,000 BTC, 4 bps fee).
    const quoted = quoteOut(120_000, 80_000_000, 1_000);
    const p = planBtcLeverage({ ...BTC, principal: 1, leverage: 2.5, quotedBtc: quoted, slippageBps: 50 });
    expect(p.borrowMusd).toBeCloseTo(120_000, 9);
    expect(p.debtMusd).toBe(p.borrowMusd);
    expect(p.postedBtc).toBeCloseTo(1 + quoted, 12);
    expect(p.minBoughtBtc).toBeCloseTo(quoted * 0.995, 12);
    // test_openLeveragesBtcInOneTransaction: HF ≈ 1.2988.
    expect(p.healthFactor).toBeCloseTo(((1 + quoted) * 80_000 * 0.78) / 120_000, 9);
    expect(p.healthFactor).toBeCloseTo(1.2988, 3);
    // HF reaches 1 when BTC falls to debt / (posted × LT).
    expect(p.liquidationPrice).toBeCloseTo(120_000 / ((1 + quoted) * 0.78), 6);
    expect(p.maxLeverage).toBeCloseTo(1 / 0.3, 9);
    expect(p.quoteDeviates).toBe(false);
    expect(p.error).toBeNull();
  });

  it('flags leverage the 70% LTV cannot carry, checked at the worst accepted swap', () => {
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.4 }).error).toMatch(/max LTV/);
    // 3.3x passes at the oracle price but not if the swap may return 2% less.
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.3 }).error).toBeNull();
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.3, slippageBps: 200 }).error).toMatch(/max LTV/);
    expect(planBtcLeverage({ ...BTC, principal: 0, leverage: 2 }).error).toMatch(/amount/);
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 1 }).error).toMatch(/above 1/);
    expect(planBtcLeverage({ ...BTC, btcPrice: 0, principal: 1, leverage: 2 }).error).toMatch(/price/);
  });

  it('knows how much the MUSD pool lends before its rates jump at the kink', () => {
    // Live pMUSD after the v4 deploy: 81 MUSD idle, nothing lent. At the 80% kink: 64.8 MUSD.
    const live: PoolState = { cash: 81, borrows: 0, reserves: 0, reserveFactor: 0.1, model: RATE_MODELS.MUSD };
    expect(borrowRoomAt(live, RATE_MODELS.MUSD.kink)).toBeCloseTo(64.8, 12);
    expect(borrowRoomAt({ ...live, cash: 20, borrows: 80 }, 0.8)).toBe(0); // already at the kink
    expect(borrowRoomAt({ ...live, borrowCap: 10 }, 0.8)).toBe(10);
    expect(borrowRoomAt(live, 1)).toBe(81); // never more than the idle cash
  });

  it('is blocked when the MUSD pool lacks the idle cash for the borrow (only 1x is needed)', () => {
    const pool: PoolState = { cash: 100_000, borrows: 0, reserves: 0, reserveFactor: 0.1, model: RATE_MODELS.MUSD };
    const p = planBtcLeverage({ ...BTC, principal: 1, leverage: 2.5, pool });
    expect(p.error).toMatch(/100,000 MUSD of idle cash for this 120,000 MUSD borrow/);
    // 100,000 MUSD funds 100,000 / (80,000 × 1.5) BTC of principal at 2.5x.
    expect(maxBtcPrincipal(2.5, { ...BTC, pool })).toBeCloseTo(100_000 / 120_000, 12);
    expect(planBtcLeverage({ ...BTC, principal: 0.8, leverage: 2.5, pool }).error).toBeNull();
    expect(planBtcLeverage({ ...BTC, principal: 0.8, leverage: 2.5, pool: { ...pool, borrowCap: 50_000 } }).error).toMatch(/borrow cap/);
  });

  it('warns when the Tigris quote is more than 1% off the oracle, either way', () => {
    const above = planBtcLeverage({ ...BTC, principal: 1, leverage: 2, quotedBtc: 0.95 });
    expect(above.priceImpact).toBeCloseTo(0.05, 9);
    expect(above.quoteDeviates).toBe(true);
    expect(above.warning).toMatch(/5\.00% fewer BTC/);
    // The pool 4.2% below Pyth: the swap returns more BTC than the oracle implies, and a close sells there.
    const below = planBtcLeverage({ ...BTC, principal: 1, leverage: 2, quotedBtc: 1 / 0.958 });
    expect(below.quoteDeviates).toBe(true);
    expect(below.warning).toMatch(/below the oracle/);
    // The 4 bps swap fee alone is not a deviation.
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 2, quotedBtc: 0.9996 }).warning).toBeNull();
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 2, quotedBtc: 0.985, maxDeviationBps: 200 }).quoteDeviates).toBe(false);
  });

  it('prices the round trip from the reverse quote and the carry at the post-open borrow rate', () => {
    const quoted = quoteOut(120_000, 80_000_000, 1_000);
    const back = quoteOut(quoted, 1_000, 80_000_000);
    // Pool: 200,000 MUSD idle, nothing lent. The open lends 120,000: utilization 60%.
    const pool: PoolState = { cash: 200_000, borrows: 0, reserves: 0, reserveFactor: 0.1, model: RATE_MODELS.MUSD };
    const p = planBtcLeverage({ ...BTC, principal: 1, leverage: 2.5, quotedBtc: quoted, quotedBackMusd: back, pool, borrowApy: 0 });
    expect(p.roundTripCostMusd).toBeCloseTo(120_000 - back, 6);
    expect(p.roundTripCostMusd!).toBeGreaterThan(120_000 * 0.0008); // at least both 4 bps fees
    expect(p.borrowApy).toBeCloseTo(aprToApy(0.06 * (0.6 / 0.8)), 12);
    expect(p.yearlyCarryMusd).toBeCloseTo(120_000 * p.borrowApy, 6);
    // Without the pool it falls back to the rate passed in.
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 2.5, borrowApy: 0.01 }).yearlyCarryMusd).toBeCloseTo(1_200, 9);
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 2.5 }).roundTripCostMusd).toBeNull();
  });

  it('checks the whole account: existing debt uses up borrowing power and moves the liquidation price', () => {
    // Already posted: 0.5 BTC ($40,000, limit $28,000, LT-weighted $31,200) against $20,000 MUSD debt.
    const account = { collateralUsd: 40_000, borrowLimitUsd: 28_000, adjustedCollateralUsd: 31_200, debtUsd: 20_000, btcUnits: 0.5 };
    const p = planBtcLeverage({ ...BTC, principal: 1, leverage: 2, account });
    expect(p.accountAfter?.debtUsd).toBeCloseTo(100_000, 9);
    expect(p.accountAfter?.healthFactor).toBeCloseTo((31_200 + 160_000 * 0.78) / 100_000, 9);
    // All 2.5 BTC must cover $100,000 at LT: 100,000 / (2.5 × 0.78).
    expect(p.liquidationPrice).toBeCloseTo(100_000 / (2.5 * 0.78), 6);
    expect(p.error).toBeNull();
    // Alone, 3.4x is past the 70% LTV; the account's $8,000 of spare borrowing power (limit 28,000 − debt 20,000) carries it.
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.4 }).error).toMatch(/max LTV/);
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.4, account }).error).toBeNull();
    // 3.2x leaves $3,200 of its own borrowing power spare: not enough for an account $3,300 over its limit.
    expect(planBtcLeverage({ ...BTC, principal: 1, leverage: 3.2, account: { ...account, debtUsd: 31_300 } }).error).toMatch(/borrow limit/);
  });

  it('keeps the posted BTC under the collateral cap, at the BTC this quote buys', () => {
    // 1 BTC at 2x posts 2 BTC at the oracle price; the cap has 1.5 BTC left.
    expect(maxBtcPrincipal(2, { ...BTC, collateralRoom: 1.5 })).toBeCloseTo(0.75, 12);
    expect(planBtcLeverage({ ...BTC, principal: 0.75, leverage: 2, collateralRoom: 1.5 }).error).toBeNull();
    // A quote 4% below the oracle buys more BTC, so less principal fits: 1.5 / (1 + 1.04).
    const p = planBtcLeverage({ ...BTC, principal: 1, leverage: 2, quotedBtc: 1.04, collateralRoom: 1.5 });
    expect(p.error).toMatch(/2\.04 BTC to post would pass the BTC collateral cap: at most 0\.735294 BTC at 2×/);
    expect(planBtcLeverage({ ...BTC, principal: 0.1, leverage: 2, collateralRoom: 0 }).error).toMatch(/collateral cap: at most 0 BTC/);
  });
});

describe('BTC close preview', () => {
  it('sells enough BTC for the live debt plus a buffer (no flash fee) and returns the rest', () => {
    // 2.5 BTC against 120,000 MUSD; selling all 2.5 BTC would fetch 200,000 MUSD.
    const c = planBtcClose({ collateralBtc: 2.5, debtMusd: 120_000, quotedMusdForAll: 200_000, slippageBps: 50 });
    const target = 120_000 * 1.001;
    expect(c.minProceeds).toBeGreaterThanOrEqual(120_000);
    expect(c.minProceeds).toBeCloseTo(target * (1 + 0.005) * (1 - 0.005), 6);
    expect(c.sellBtc).toBeCloseTo((target * 1.005) / 80_000, 12);
    expect(c.collateralBack).toBeCloseTo(2.5 - c.sellBtc, 12);
    expect(c.musdBack).toBeCloseTo(target * 1.005 - 120_000, 6);
    expect(c.error).toBeNull();
  });

  it('sizes the sale at its own quote, which a smaller sale always meets', () => {
    // Thin pool: 100 BTC / 8M MUSD. Selling all 10 BTC averages far below what selling ~1.5 BTC does.
    const all = quoteOut(10, 100, 8_000_000);
    const draft = planBtcClose({ collateralBtc: 10, debtMusd: 120_000, quotedMusdForAll: all, slippageBps: 50 });
    const atDraft = quoteOut(draft.sellBtc, 100, 8_000_000);
    const final = planBtcClose({
      collateralBtc: 10,
      debtMusd: 120_000,
      quotedMusdForAll: all,
      slippageBps: 50,
      quote: { sellBtc: draft.sellBtc, musd: atDraft },
    });
    expect(final.sellBtc).toBeLessThan(draft.sellBtc);
    // The refined sale still raises the debt, buffer and slippage, and leaves little MUSD exposed to a sandwich.
    expect(quoteOut(final.sellBtc, 100, 8_000_000)).toBeGreaterThanOrEqual(120_000 * 1.001 * 1.005);
    expect(final.musdBack).toBeLessThan(120_000 * 0.01);
  });

  it('cannot close when even selling everything would not repay', () => {
    expect(planBtcClose({ collateralBtc: 1, debtMusd: 90_000, quotedMusdForAll: 80_000 }).error).toMatch(/not enough/);
  });

  it('flags a sale far below the oracle price', () => {
    const quote = { sellBtc: 1.6, musd: 1.6 * 76_640 }; // Tigris 4.2% below an $80,000 oracle
    const c = planBtcClose({ collateralBtc: 2.5, debtMusd: 120_000, quotedMusdForAll: 190_000, quote, btcPrice: 80_000, musdPrice: 1 });
    expect(c.priceGap).toBeCloseTo(0.042, 9);
    expect(c.quoteDeviates).toBe(true);
    expect(c.warning).toMatch(/4\.20% less than the oracle/);
    expect(planBtcClose({ collateralBtc: 2.5, debtMusd: 120_000, quotedMusdForAll: 199_900, btcPrice: 80_000 }).warning).toBeNull();
  });

  it('needs no price without other debt; other debt must stay covered without the BTC', () => {
    const terms = { collateralBtc: 2.5, debtMusd: 120_000, quotedMusdForAll: 200_000 };
    expect(planBtcClose(terms)).toMatchObject({ needsPrices: false, error: null });
    // MEZO debt that WETH covers: the withdrawal runs the risk check, so prices go along.
    const covered = { debtUsd: 500, borrowLimitUsd: 7_500, debtPriced: true };
    expect(planBtcClose({ ...terms, rest: covered })).toMatchObject({ needsPrices: true, error: null });
    expect(planBtcClose({ ...terms, rest: { ...covered, borrowLimitUsd: 400 } }).error).toMatch(/other debt \(\$500\) relies on this BTC/);
    expect(planBtcClose({ ...terms, rest: { ...covered, debtPriced: false } }).error).toMatch(/no usable price/);
    // Nothing else owed: the rest does not matter.
    expect(planBtcClose({ ...terms, rest: { debtUsd: 0, borrowLimitUsd: 0, debtPriced: true } })).toMatchObject({ needsPrices: false, error: null });
    // With no MUSD debt the contract has nothing to repay (ZeroAmount).
    expect(planBtcClose({ ...terms, debtMusd: 0 }).error).toMatch(/no MUSD debt/);
  });
});

describe('MUSD loop preview at the rates it leaves the pool at', () => {
  // Live pMUSD (backlog): 109.34 cash, 1.83 borrowed, 0.167 reserves; IRM 0 / 6% / kink 80% / 80%, reserve factor 10%.
  const live: PoolState = { cash: 109.34, borrows: 1.83, reserves: 0.167, reserveFactor: 0.1, model: RATE_MODELS.MUSD };
  const terms = { ltvBps: 8_000, ltBps: 8_500, pool: live };

  it('prices a 25 MUSD 4x loop at the post-loop utilization, not the pre-loop rates', () => {
    const p = planLoop(25, 4, terms);
    // cash 134.34, borrows 1.83 + 75.0675, reserves 0.167 + 0.0675: utilization ≈ 36.4%.
    const u = utilization(134.34, 1.83 + 75.0675, 0.167 + 0.0675);
    expect(p.utilization).toBeCloseTo(u, 12);
    expect(u).toBeCloseTo(0.3644, 3);
    // On-chain IRM at that state: borrow 2.73%, supply 0.896% (APR), compounded here.
    expect(borrowRate(RATE_MODELS.MUSD, u)).toBeCloseTo(0.0273, 4);
    expect(supplyRate(RATE_MODELS.MUSD, u, 0.1)).toBeCloseTo(0.00896, 4);
    expect(p.borrowApy).toBeCloseTo(aprToApy(borrowRate(RATE_MODELS.MUSD, u)), 12);
    expect(p.supplyApy).toBeCloseTo(aprToApy(supplyRate(RATE_MODELS.MUSD, u, 0.1)), 12);
    expect(p.netApy).toBeCloseTo((100 * p.supplyApy - 75.0675 * p.borrowApy) / 25, 12);
    // About −4.7% a year, against −0.36% at the pre-loop rates the old preview used.
    expect(p.netApy).toBeLessThan(-0.045);
    const naive = planLoop(25, 4, { ltvBps: 8_000, ltBps: 8_500, supplyApy: 0.0000183, borrowApy: 0.00123 });
    expect(p.netApy / naive.netApy).toBeGreaterThan(10);
    // Plain supply of the same 25 MUSD barely moves utilization: it earns ~0.001%, so the loop costs ~4.7% more.
    expect(p.plainSupplyApy).toBeGreaterThan(0);
    expect(p.plainSupplyApy).toBeLessThan(0.0001);
    expect(p.vsPlainSupply).toBeCloseTo(p.netApy - p.plainSupplyApy, 12);
    expect(p.feeCost).toBeCloseTo(0.0675 / 25, 12);
    expect(p.error).toBeNull();
  });

  it('sizes the loop to the flash liquidity and the caps', () => {
    // PRD flow C (1,000 MUSD at 3x) needs a 2,000 MUSD flash loan: the live pool has 109.34.
    const p = planLoop(1_000, 3, terms);
    expect(p.error).toMatch(/109\.34 MUSD of idle cash for a 2,000 MUSD flash loan: at most 54\.67 MUSD at 3×/);
    expect(p.maxPrincipal).toBeCloseTo(109.34 / 2, 12);
    expect(planLoop(54, 3, terms).error).toBeNull();
    expect(planLoop(1, 3, { ...terms, pool: { ...live, cash: 0 } }).error).toMatch(/no idle MUSD/);
    // Supply cap 200: 111 already supplied, so a 3x loop may add 89 gross.
    expect(maxLoopPrincipal(3, { ...terms, pool: { ...live, supplyCap: 200 } })).toBeCloseTo((200 - (109.34 + 1.83 - 0.167)) / 3, 9);
    expect(planLoop(40, 3, { ...terms, pool: { ...live, supplyCap: 200 } }).error).toMatch(/supply cap/);
    expect(planLoop(40, 3, { ...terms, pool: { ...live, borrowCap: 50 } }).error).toMatch(/borrow cap/);
    // pMUSD collateral cap with 90 MUSD of room: the 3x deposit posts 3 × principal.
    expect(maxLoopPrincipal(3, { ...terms, collateralRoom: 90 })).toBeCloseTo(30, 12);
    expect(planLoop(31, 3, { ...terms, collateralRoom: 90 }).error).toMatch(/93 MUSD of pMUSD would pass the pMUSD collateral cap: at most 30 MUSD at 3×/);
    expect(planLoop(30, 3, { ...terms, collateralRoom: 90 }).error).toBeNull();
  });

  it('checks the whole account: other collateral can carry more, other debt less', () => {
    // $10,000 of WETH at 75% LTV: $7,500 of borrowing power.
    const weth = { collateralUsd: 10_000, borrowLimitUsd: 7_500, adjustedCollateralUsd: 8_000, debtUsd: 0 };
    const loopOnly = { ltvBps: 8_000, ltBps: 8_500 };
    expect(planLoop(1_000, 6, loopOnly).error).toMatch(/max LTV/);
    expect(planLoop(1_000, 6, { ...loopOnly, account: weth }).error).toBeNull();
    // With $7,000 already borrowed only $500 of headroom is left: L ≤ (500 / 1,000 + 1.0009) / (1.0009 − 0.8).
    const busy = { ...weth, debtUsd: 7_000 };
    const p = planLoop(1_000, 8, { ...loopOnly, account: busy });
    expect(p.leverageLimit).toBeCloseTo((0.5 + 1.0009) / 0.2009, 9);
    expect(p.error).toMatch(/borrow limit \(max ≈ 7\.47× for this amount\)/);
    expect(planLoop(1_000, 7, { ...loopOnly, account: busy }).error).toBeNull();
    // Health after the loop is the account's, not the loop's own.
    const q = planLoop(1_000, 3, { ...loopOnly, account: busy, musdPrice: 0.99 });
    expect(q.accountAfter?.healthFactor).toBeCloseTo((8_000 + 3_000 * 0.99 * 0.85) / (7_000 + 2_001.8 * 0.99), 9);
    expect(q.healthFactor).toBeCloseTo((3_000 * 0.85) / 2_001.8, 9);
    expect(q.liquidationBuffer).toBeCloseTo(1 - 1 / q.accountAfter!.healthFactor, 12);
    expect(planLoop(1_000, 3, { ...loopOnly, account: { ...weth, debtUsd: 8_000 } }).error).toMatch(/already over its borrow limit/);
  });

  it('keeps the legacy inputs working (current rates, no pool)', () => {
    const p = planLoop(1_000, 3, { ltvBps: 8_000, ltBps: 8_500, supplyApy: 0.05, borrowApy: 0.04 });
    expect(p.netApy).toBeCloseTo((3_000 * 0.05 - 2_001.8 * 0.04) / 1_000, 12);
    expect(p.utilization).toBeNull();
    expect(p.plainSupplyApy).toBe(0.05);
    expect(p.maxPrincipal).toBe(Infinity);
    expect(planLoop(1_000, 11, { ltvBps: 8_000, ltBps: 8_500 }).error).toMatch(/capped at 10×/);
  });
});

describe('MUSD loop unwind (debt netted against pMUSD)', () => {
  it('mirrors the contract tests: no flash fee, works with no idle cash, short cash comes back as pMUSD', () => {
    // LeverageManager.t.sol: 1,000 MUSD at 3x leaves 3,000 pMUSD against 2,001.8 MUSD of debt.
    const dry = planUnwind({ debt: 2_001.8, collateral: 3_000, cash: 0 });
    expect(dry).toMatchObject({ netted: 2_001.8, debtLeft: 0, withdrawAll: true, out: 0, needsPrices: false, error: null });
    expect(dry.withdrawn).toBeCloseTo(998.2, 9);
    expect(dry.returned).toBeCloseTo(998.2, 9);
    expect(dry.equity).toBeCloseTo(998.2, 9);
    const short = planUnwind({ debt: 2_001.8, collateral: 3_000, cash: 500 });
    expect(short.out).toBe(500);
    expect(short.returned).toBeCloseTo(498.2, 9);
    expect(short.minOut).toBeCloseTo(998.2 * 0.995, 9);
    expect(planUnwind({ debt: 2_001.8, collateral: 3_000, cash: 10_000 }).out).toBeCloseTo(998.2, 9);
  });

  it('shows negative equity and repays what the pMUSD covers when other collateral backs the rest', () => {
    const rest = { collateral: true, debtUsd: 0, borrowLimitUsd: 7_500, debtPriced: true };
    const u = planUnwind({ debt: 3_000, collateral: 2_000, cash: 1_000, rest });
    expect(u).toMatchObject({ equity: -1_000, netted: 2_000, debtLeft: 1_000, withdrawn: 0, out: 0, needsPrices: false, error: null });
    // Without other collateral the netting would leave debt with nothing behind it (WouldLeaveBadDebt).
    expect(planUnwind({ debt: 3_000, collateral: 2_000, cash: 1_000 }).error).toMatch(/repay 1,000 MUSD first/);
  });

  it('keeps the pMUSD that other debt needs posted, and only then needs prices', () => {
    // 500 USD of MEZO debt with no other collateral: 500 / 0.8 = 625 MUSD of pMUSD must stay.
    const rest = { collateral: false, debtUsd: 500, borrowLimitUsd: 0, debtPriced: true };
    const u = planUnwind({ debt: 2_001.8, collateral: 3_000, cash: 10_000, rest, musdPrice: 1, ltvBps: 8_000 });
    expect(u.withdrawn).toBeCloseTo((998.2 - 625) * 0.999, 9);
    expect(u.kept).toBeCloseTo(998.2 - u.withdrawn, 9);
    expect(u.withdrawAll).toBe(false);
    expect(u.needsPrices).toBe(true);
    // Covered by other collateral: everything may leave, still with a risk check.
    expect(planUnwind({ debt: 2_001.8, collateral: 3_000, cash: 10_000, rest: { ...rest, borrowLimitUsd: 600 }, musdPrice: 1, ltvBps: 8_000 })).toMatchObject({
      withdrawAll: true,
      needsPrices: true,
    });
    // Without a usable price for that debt nothing can be withdrawn: the unwind only nets, which needs no price.
    const netOnly = planUnwind({ debt: 2_001.8, collateral: 3_000, cash: 10_000, rest: { ...rest, debtPriced: false }, musdPrice: 1, ltvBps: 8_000 });
    expect(netOnly).toMatchObject({ netted: 2_001.8, withdrawn: 0, needsPrices: false, error: null });
    expect(planUnwind({ debt: 0, collateral: 3_000, cash: 0, rest: { ...rest, debtPriced: false } }).error).toMatch(/no usable price/);
    // Other debt with no price at all (valued at $0) still holds the pMUSD back.
    const unvalued = planUnwind({
      debt: 2_001.8,
      collateral: 3_000,
      cash: 10_000,
      rest: { ...rest, debtUsd: 0, debtPriced: false },
      musdPrice: 1,
      ltvBps: 8_000,
    });
    expect(unvalued).toMatchObject({ withdrawn: 0, needsPrices: false, error: null });
  });
});

describe('liquidation split', () => {
  it('gives the protocol its share of the bonus only', () => {
    // 1,100 units seized at a 10% bonus: 100 is bonus, the protocol keeps 10% of it.
    const s = liquidatorShare(1_100, 1_000, 1_000);
    expect(s.toProtocol).toBeCloseTo(10, 9);
    expect(s.toLiquidator).toBeCloseTo(1_090, 9);
    expect(liquidatorShare(1_100, 1_000, 0).toProtocol).toBe(0);
  });
});
