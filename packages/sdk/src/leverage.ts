import { BPS, FLASH_FEE_BPS, extendPosition, flashFee, poolRates, poolSupplied, type AccountTotals, type PoolState, type PositionSummary } from './math';

/**
 * Previews of the one-transaction leverage products: LeverageManager (MUSD → pMUSD loop on the pool's flash
 * loan, unwound by netting the debt against the posted pMUSD) and SwapLeverageManager (a BTC long through a
 * Tigris flash swap, with no flash fee). Amounts are token units, values USD. Given `pool`, a preview prices the
 * carry at the state the position leaves the pool in and checks its liquidity and caps; given `account`, it
 * runs VaultManager's borrow check on the whole account rather than on the new position alone.
 */

/** LeverageManager.MAX_LEVERAGE */
export const MAX_LOOP_LEVERAGE = 10;
/** Gap between a Tigris quote and the oracle price from which BTC previews flag the quote (1%). */
export const QUOTE_DEVIATION_BPS = 100;
/** MUSD a BTC close raises beyond the debt, for interest accrued before the transaction lands (0.1%). */
export const CLOSE_BUFFER_BPS = 10;
/** Share of the computed headroom a withdrawal uses, leaving room for price moves before inclusion. */
const WITHDRAW_MARGIN = 0.999;

const FLASH_FEE = FLASH_FEE_BPS / BPS;
const amount = (n: number, digits = 2) => n.toLocaleString('en-US', { maximumFractionDigits: digits });
const percent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;

// --- MUSD loop (LeverageManager.loop) ----------------------------------------------------------

export type LoopTerms = {
  /** pMUSD collateral LTV and liquidation threshold. */
  ltvBps: number;
  ltBps: number;
  /** Current pool rates (annual); the carry uses them only without `pool`. */
  supplyApy?: number;
  borrowApy?: number;
  /** The MUSD pool before the loop: prices the carry at the state the loop leaves and checks liquidity and caps. */
  pool?: PoolState;
  /** The account before the loop, valued like VaultManager: the borrow check and health then cover all of it. */
  account?: AccountTotals;
  /** USD per MUSD, to value the loop inside `account` (default 1). */
  musdPrice?: number;
  /** pMUSD the VaultManager collateral cap still accepts, in MUSD at the exchange rate (default: uncapped). */
  collateralRoom?: number;
};

export type LoopPlan = {
  principal: number;
  leverage: number;
  flashAmount: number;
  fee: number;
  /** Gross supplied position (principal + flash amount). */
  gross: number;
  /** Debt opened by the loop (flash amount + fee). */
  debt: number;
  /** The loop's own LTV and health factor (its pMUSD against its debt). */
  ltv: number;
  healthFactor: number;
  /** Max leverage allowed by the collateral LTV alone: 1 / (1 − LTV). */
  maxLeverage: number;
  /** Highest leverage the borrow check allows for this principal, net of the flash fee (the account's headroom with `account`). */
  leverageLimit: number;
  /** Net APY on equity, (gross × supplyApy − debt × borrowApy) / principal. */
  netApy: number;
  /** Rates the carry is priced at: the pool after the loop with `pool`, else the rates passed in. */
  supplyApy: number;
  borrowApy: number;
  /** Pool utilization after the loop (null without `pool`). */
  utilization: number | null;
  /** APY of supplying the same principal without the loop (at the state that deposit leaves, with `pool`). */
  plainSupplyApy: number;
  /** netApy − plainSupplyApy: what the loop adds per year over plain supply (negative: what it costs). */
  vsPlainSupply: number;
  /** The flash fee as a share of equity, paid once when the loop opens (it goes to the pool's reserves). */
  feeCost: number;
  /** Fractional fall in collateral value that would make the position liquidatable (the whole account's with `account`). */
  liquidationBuffer: number;
  /** The account after the loop (with `account`): what VaultManager's borrow check sees. */
  accountAfter: PositionSummary | null;
  /** Largest principal the loop accepts at this leverage (see maxLoopPrincipal). */
  maxPrincipal: number;
  error: string | null;
};

/**
 * Largest principal LeverageManager.loop accepts at `leverage`: the flash loan comes out of the pool's idle cash,
 * the gross deposit must fit the supply cap and the pMUSD collateral cap, and the new debt the borrow cap. Past the
 * leverage the pMUSD supports on its own, the account's spare borrowing power bounds it too.
 */
export function maxLoopPrincipal(leverage: number, terms: LoopTerms): number {
  if (!(leverage > 1)) return 0;
  const debtPerPrincipal = (leverage - 1) * (1 + FLASH_FEE);
  let max = Math.max(0, terms.collateralRoom ?? Infinity) / leverage;
  const pool = terms.pool;
  if (pool) {
    max = Math.min(
      max,
      pool.cash / (leverage - 1),
      ((pool.supplyCap ?? Infinity) - poolSupplied(pool)) / leverage,
      ((pool.borrowCap ?? Infinity) - pool.borrows) / debtPerPrincipal,
    );
  }
  // Borrowing power each MUSD of principal uses beyond what its own pMUSD adds.
  const excess = debtPerPrincipal - (leverage * terms.ltvBps) / BPS;
  if (excess > 0) {
    const headroom = terms.account ? terms.account.borrowLimitUsd - terms.account.debtUsd : 0;
    max = Math.min(max, Math.max(0, headroom) / ((terms.musdPrice ?? 1) * excess));
  }
  return Math.max(0, max);
}

/** Mirrors LeverageManager.loop: flash = principal × (L − 1); debt = flash + 9 bps fee, borrowed against the pMUSD. */
export function planLoop(principal: number, leverage: number, p: LoopTerms): LoopPlan {
  const flashAmount = principal * (leverage - 1);
  const fee = flashFee(flashAmount);
  const gross = principal + flashAmount;
  const debt = flashAmount + fee;
  const ltvMax = p.ltvBps / BPS;
  const ltv = gross > 0 ? debt / gross : 0;
  const healthFactor = debt > 0 ? (gross * p.ltBps) / BPS / debt : Infinity;
  const maxLeverage = 1 / (1 - ltvMax);
  const musdPrice = p.musdPrice ?? 1;

  // Supply and debt land in the same pool: cash + principal (the flash goes out and comes back with the fee),
  // borrows + debt, reserves + fee. Plain supply would only add the principal to cash.
  const pool = p.pool;
  const after = pool ? poolRates({ ...pool, cash: pool.cash + principal, borrows: pool.borrows + debt, reserves: pool.reserves + fee }) : null;
  const supplyApy = after ? after.supplyApy : (p.supplyApy ?? 0);
  const borrowApy = after ? after.borrowApy : (p.borrowApy ?? 0);
  const plainSupplyApy = pool ? poolRates({ ...pool, cash: pool.cash + principal }).supplyApy : (p.supplyApy ?? 0);
  const netApy = principal > 0 ? (gross * supplyApy - debt * borrowApy) / principal : 0;

  const accountAfter = p.account
    ? extendPosition(p.account, { collateralUsd: gross * musdPrice, ltvBps: p.ltvBps, ltBps: p.ltBps, debtUsd: debt * musdPrice })
    : null;
  const hfAfter = accountAfter ? accountAfter.healthFactor : healthFactor;
  const liquidationBuffer = Number.isFinite(hfAfter) ? Math.max(0, 1 - 1 / hfAfter) : 1;
  // Borrow check: debt + P·pm·(L − 1)(1 + f) ≤ limit + P·pm·L·LTV  ⇔  L ≤ (headroom / (P·pm) + 1 + f) / (1 + f − LTV).
  const headroom = p.account ? p.account.borrowLimitUsd - p.account.debtUsd : 0;
  const leverageLimit =
    principal > 0 && musdPrice > 0
      ? Math.min(MAX_LOOP_LEVERAGE, (headroom / (principal * musdPrice) + 1 + FLASH_FEE) / (1 + FLASH_FEE - ltvMax))
      : Math.min(MAX_LOOP_LEVERAGE, maxLeverage);
  const maxPrincipal = maxLoopPrincipal(leverage, p);
  const atMost = `at most ${amount(maxPrincipal)} MUSD at ${leverage}×`;

  let error: string | null = null;
  if (!Number.isFinite(principal) || principal <= 0) error = 'Enter a valid amount';
  else if (leverage <= 1) error = 'Leverage must be above 1×';
  else if (leverage > MAX_LOOP_LEVERAGE) error = `Leverage is capped at ${MAX_LOOP_LEVERAGE}×`;
  else if (pool && flashAmount > pool.cash)
    error =
      pool.cash > 0
        ? `The pool has ${amount(pool.cash)} MUSD of idle cash for a ${amount(flashAmount)} MUSD flash loan: ${atMost}`
        : 'The pool has no idle MUSD to flash-loan right now';
  else if (pool && gross > (pool.supplyCap ?? Infinity) - poolSupplied(pool))
    error = `The ${amount(gross)} MUSD deposit would pass the pool's supply cap: ${atMost}`;
  else if (gross > (p.collateralRoom ?? Infinity)) error = `The ${amount(gross)} MUSD of pMUSD would pass the pMUSD collateral cap: ${atMost}`;
  else if (pool && pool.borrows + debt > (pool.borrowCap ?? Infinity)) error = `The ${amount(debt)} MUSD borrow would pass the pool's borrow cap: ${atMost}`;
  else if (accountAfter && accountAfter.debtUsd > accountAfter.borrowLimitUsd)
    error =
      headroom < 0
        ? 'Your account is already over its borrow limit: repay debt or add collateral first'
        : `${leverage}× exceeds your borrow limit (max ≈ ${leverageLimit.toFixed(2)}× for this amount)`;
  else if (!accountAfter && ltv > ltvMax) error = `${leverage}× exceeds the ${(p.ltvBps / 100).toFixed(0)}% max LTV (max ≈ ${maxLeverage.toFixed(2)}×)`;

  return {
    principal,
    leverage,
    flashAmount,
    fee,
    gross,
    debt,
    ltv,
    healthFactor,
    maxLeverage,
    leverageLimit,
    netApy,
    supplyApy,
    borrowApy,
    utilization: after ? after.utilization : null,
    plainSupplyApy,
    vsPlainSupply: netApy - plainSupplyApy,
    feeCost: principal > 0 ? fee / principal : 0,
    liquidationBuffer,
    accountAfter,
    maxPrincipal,
    error,
  };
}

// --- MUSD loop unwind (LeverageManager.unwind) -------------------------------------------------

export type UnwindTerms = {
  /** MUSD debt (units). */
  debt: number;
  /** Posted pMUSD at its redemption value (MUSD units). */
  collateral: number;
  /** The pool's idle cash (MUSD units): how much of the equity it can pay out in MUSD now. */
  cash: number;
  /**
   * The rest of the account, without the MUSD debt and the pMUSD (USD, valued like VaultManager). Pass it whenever
   * the account holds or owes anything else: debt may stay after the netting only if other collateral backs it,
   * and other debt limits how much pMUSD may leave. `debtPriced` is false when one of those debts has no usable
   * price (any withdrawal would then revert).
   */
  rest?: { collateral: boolean; debtUsd: number; borrowLimitUsd: number; debtPriced: boolean };
  /** Usable USD price of MUSD (0 when there is none: pMUSD then counts as $0 toward the limit) and the pMUSD LTV. */
  musdPrice?: number;
  ltvBps?: number;
  /** Accepted shortfall of the equity returned against this preview (default 50 bps). */
  slippageBps?: number;
};

export type UnwindPlan = {
  /** pMUSD value minus MUSD debt (MUSD): negative when part of the debt is backed by other collateral. */
  equity: number;
  /** Debt repaid by burning posted pMUSD (VaultManager.repayWithCollateral): no flash loan, no fee, no idle cash. */
  netted: number;
  /** MUSD debt left after the netting. */
  debtLeft: number;
  /** pMUSD value withdrawn after the netting, and what stays posted to back other debt. */
  withdrawn: number;
  kept: number;
  /** Whether everything left is withdrawn (pass type(uint256).max as `shares`). */
  withdrawAll: boolean;
  /** Of `withdrawn`: MUSD the pool's idle cash pays out now, and the value returned as pMUSD for the rest. */
  out: number;
  returned: number;
  /** Least equity the transaction must return (MUSD paid out plus returned pMUSD at its value): `minOut`. */
  minOut: number;
  /** Debt remains when pMUSD is withdrawn, so the risk check runs and needs fresh prices. A full unwind needs none. */
  needsPrices: boolean;
  error: string | null;
};

/** Mirrors LeverageManager.unwind(type(uint256).max, shares, minOut): net all the debt the pMUSD covers, then withdraw. */
export function planUnwind(p: UnwindTerms): UnwindPlan {
  const debt = Math.max(0, p.debt);
  const collateral = Math.max(0, p.collateral);
  const rest = p.rest;
  const netted = Math.min(debt, collateral);
  const debtLeft = debt - netted;
  const left = collateral - netted;
  const restDebt = rest?.debtUsd ?? 0;
  // Other markets' debt, also when it has no price at all to value it by.
  const otherDebt = restDebt > 0 || rest?.debtPriced === false;

  // pMUSD is left only when the MUSD debt is gone, so only other markets' debt can hold it back.
  let withdrawn = left;
  if (left > 0 && otherDebt) {
    const restLimit = rest?.borrowLimitUsd ?? 0;
    const limitPerUnit = ((p.musdPrice ?? 0) * (p.ltvBps ?? 0)) / BPS;
    if (!rest?.debtPriced) withdrawn = 0;
    else if (restDebt <= restLimit) withdrawn = left;
    else if (limitPerUnit > 0) withdrawn = Math.min(left, Math.max(0, (left - (restDebt - restLimit) / limitPerUnit) * WITHDRAW_MARGIN));
    else withdrawn = 0;
  }
  const out = Math.min(withdrawn, Math.max(0, p.cash));

  let error: string | null = null;
  if (debtLeft > 0 && !rest?.collateral)
    error = `Your pMUSD (${amount(collateral)} MUSD) does not cover the ${amount(debt)} MUSD debt: repay ${amount(debtLeft)} MUSD first, since netting it all would leave debt with no collateral`;
  else if (netted === 0 && withdrawn === 0)
    error = left > 0 && rest && !rest.debtPriced ? 'Another debt has no usable price right now, so no pMUSD can be withdrawn' : 'Nothing to unwind';

  return {
    equity: collateral - debt,
    netted,
    debtLeft,
    withdrawn,
    kept: left - withdrawn,
    withdrawAll: withdrawn >= left,
    out,
    returned: withdrawn - out,
    minOut: (withdrawn * (BPS - (p.slippageBps ?? 50))) / BPS,
    needsPrices: withdrawn > 0 && otherDebt,
    error,
  };
}

// --- BTC leverage (SwapLeverageManager) ---------------------------------------------------------

export type BtcLeverageTerms = {
  principal: number;
  leverage: number;
  btcPrice: number;
  musdPrice: number;
  ltvBps: number;
  ltBps: number;
  /** BTC the Tigris pool quotes for `borrowMusd` (pair.getAmountOut); the oracle price stands in without it. */
  quotedBtc?: number;
  slippageBps?: number;
  /** MUSD the pool quotes for selling the bought BTC straight back: prices the round trip. */
  quotedBackMusd?: number;
  /** Quote-vs-oracle gap above which the plan flags the quote (default QUOTE_DEVIATION_BPS). */
  maxDeviationBps?: number;
  /** The MUSD pool: the open needs idle cash for the borrow and room under the borrow cap; prices the carry after it. */
  pool?: PoolState;
  /** Current MUSD borrow APY, used without `pool`. */
  borrowApy?: number;
  /** The account before the open; `btcUnits` is the BTC it already has posted (for the liquidation price). */
  account?: AccountTotals & { btcUnits?: number };
  /** BTC the VaultManager collateral cap still accepts (default: uncapped). */
  collateralRoom?: number;
};

export type BtcLeveragePlan = {
  principal: number;
  leverage: number;
  /** MUSD borrowed to pay for the BTC the flash swap delivers. */
  borrowMusd: number;
  /** BTC the swap is expected to return (router quote, else the oracle price). */
  boughtBtc: number;
  /** Least BTC the transaction accepts from the swap. */
  minBoughtBtc: number;
  postedBtc: number;
  /** MUSD debt opened: exactly `borrowMusd` (the borrow pays the pool; no flash fee). */
  debtMusd: number;
  /** The new position's own LTV and health factor. */
  ltv: number;
  healthFactor: number;
  /** BTC/USD price at which the health factor reaches 1 (the whole account's with `account`). */
  liquidationPrice: number;
  /** 1 / (1 − LTV). */
  maxLeverage: number;
  /** Shortfall of the router quote against the oracle price (0.05 = 5% fewer BTC; negative: more BTC). */
  priceImpact: number;
  /** The quote is further than `maxDeviationBps` from the oracle price, either way. */
  quoteDeviates: boolean;
  /** What a deviating quote means for this position; null when the quote is close to the oracle. */
  warning: string | null;
  /** MUSD lost opening and closing again straight away at today's quotes (swap fees and price impact both ways). */
  roundTripCostMusd: number | null;
  /** MUSD borrow APY once open (the pool with `borrowMusd` more lent out), else the rate passed in. */
  borrowApy: number;
  /** Yearly MUSD interest on the debt at `borrowApy`. */
  yearlyCarryMusd: number;
  /** The account after the open (with `account`): what VaultManager's borrow check sees. */
  accountAfter: PositionSummary | null;
  error: string | null;
};

/**
 * Largest principal (BTC) SwapLeverageManager.open accepts at `leverage`: the borrow must fit the MUSD pool's idle
 * cash and borrow cap, the posted BTC the collateral cap, and past the leverage the BTC supports on its own, the
 * account's spare borrowing power. Assumes a swap at the oracle price less `slippageBps`.
 */
export function maxBtcPrincipal(
  leverage: number,
  terms: Pick<BtcLeverageTerms, 'btcPrice' | 'musdPrice' | 'ltvBps' | 'slippageBps' | 'pool' | 'account' | 'collateralRoom'>,
): number {
  if (!(leverage > 1) || !(terms.btcPrice > 0) || !(terms.musdPrice > 0)) return 0;
  const borrowPerBtc = (terms.btcPrice * (leverage - 1)) / terms.musdPrice;
  // At the oracle price each BTC of principal posts `leverage` BTC.
  let max = Math.max(0, terms.collateralRoom ?? Infinity) / leverage;
  if (terms.pool) max = Math.min(max, terms.pool.cash / borrowPerBtc, ((terms.pool.borrowCap ?? Infinity) - terms.pool.borrows) / borrowPerBtc);
  const worstPosted = 1 + (leverage - 1) * (1 - (terms.slippageBps ?? 0) / BPS);
  const excessUsd = terms.btcPrice * (leverage - 1 - (worstPosted * terms.ltvBps) / BPS);
  if (excessUsd > 0) {
    const headroom = terms.account ? terms.account.borrowLimitUsd - terms.account.debtUsd : 0;
    max = Math.min(max, Math.max(0, headroom) / excessUsd);
  }
  return Math.max(0, max);
}

/**
 * SwapLeverageManager.open preview: `principal` BTC taken to `leverage`× by a flash swap of BTC from the Tigris
 * MUSD/BTC pool, paid for by borrowing MUSD. The borrow check uses the worst swap the transaction accepts (quote
 * minus `slippageBps`), so a plan that passes here does not revert on the borrow limit.
 */
export function planBtcLeverage(p: BtcLeverageTerms): BtcLeveragePlan {
  const borrowMusd = p.musdPrice > 0 ? (p.principal * p.btcPrice * (p.leverage - 1)) / p.musdPrice : 0;
  const oracleBtc = p.btcPrice > 0 ? (borrowMusd * p.musdPrice) / p.btcPrice : 0;
  const boughtBtc = p.quotedBtc ?? oracleBtc;
  const minBoughtBtc = (boughtBtc * (BPS - (p.slippageBps ?? 0))) / BPS;
  const postedBtc = p.principal + boughtBtc;
  const debtMusd = borrowMusd;
  const debtUsd = debtMusd * p.musdPrice;
  const collateralUsd = postedBtc * p.btcPrice;
  const maxLeverage = 1 / (1 - p.ltvBps / BPS);

  const priceImpact = oracleBtc > 0 ? 1 - boughtBtc / oracleBtc : 0;
  const quoteDeviates = p.quotedBtc !== undefined && Math.abs(priceImpact) * BPS > (p.maxDeviationBps ?? QUOTE_DEVIATION_BPS);
  const warning = !quoteDeviates
    ? null
    : priceImpact > 0
      ? `Tigris quotes ${percent(priceImpact)} fewer BTC than the oracle price implies: you buy above the price the position is valued at`
      : `Tigris quotes ${percent(-priceImpact)} more BTC than the oracle price implies: its BTC price is below the oracle, so the position is valued above what selling on Tigris raises, and a close sells there`;

  const pool = p.pool;
  const borrowApy = pool ? poolRates({ ...pool, cash: pool.cash - borrowMusd, borrows: pool.borrows + borrowMusd }).borrowApy : (p.borrowApy ?? 0);

  const accountAfter = p.account ? extendPosition(p.account, { collateralUsd, ltvBps: p.ltvBps, ltBps: p.ltBps, debtUsd }) : null;
  // HF reaches 1 when the BTC (held before plus posted now) times LT covers the debt the other collateral does not.
  const btcBefore = p.account?.btcUnits ?? 0;
  const otherAdjustedUsd = p.account ? p.account.adjustedCollateralUsd - (btcBefore * p.btcPrice * p.ltBps) / BPS : 0;
  const btcAfter = btcBefore + postedBtc;
  const liquidationPrice = btcAfter > 0 ? Math.max(0, ((p.account?.debtUsd ?? 0) + debtUsd - otherAdjustedUsd) / ((btcAfter * p.ltBps) / BPS)) : 0;

  const worstLimitUsd = ((p.principal + minBoughtBtc) * p.btcPrice * p.ltvBps) / BPS;
  const overLimit = p.account ? p.account.debtUsd + debtUsd > p.account.borrowLimitUsd + worstLimitUsd : debtUsd > worstLimitUsd;
  const atMost = () => `at most ${amount(maxBtcPrincipal(p.leverage, p), 6)} BTC at ${p.leverage}×`;

  let error: string | null = null;
  if (!Number.isFinite(p.principal) || p.principal <= 0) error = 'Enter a valid amount';
  else if (p.leverage <= 1) error = 'Leverage must be above 1×';
  else if (!(p.btcPrice > 0) || !(p.musdPrice > 0)) error = 'No usable BTC and MUSD prices right now';
  else if (pool && borrowMusd > pool.cash)
    error = `The MUSD pool has ${amount(Math.max(0, pool.cash))} MUSD of idle cash for this ${amount(borrowMusd)} MUSD borrow: ${atMost()}`;
  else if (pool && pool.borrows + borrowMusd > (pool.borrowCap ?? Infinity))
    error = `The ${amount(borrowMusd)} MUSD borrow would pass the pool's borrow cap: ${atMost()}`;
  else if (postedBtc > (p.collateralRoom ?? Infinity))
    // Sized at this quote's BTC per principal, which may beat the oracle price that maxBtcPrincipal assumes.
    error = `The ${amount(postedBtc, 6)} BTC to post would pass the BTC collateral cap: at most ${amount((Math.max(0, p.collateralRoom ?? 0) * p.principal) / postedBtc, 6)} BTC at ${p.leverage}×`;
  else if (overLimit)
    error = p.account
      ? `${p.leverage}× exceeds your borrow limit at the worst accepted swap: ${atMost()}`
      : `${p.leverage}× exceeds the ${p.ltvBps / 100}% max LTV (max ≈ ${maxLeverage.toFixed(2)}× before swap costs)`;

  return {
    principal: p.principal,
    leverage: p.leverage,
    borrowMusd,
    boughtBtc,
    minBoughtBtc,
    postedBtc,
    debtMusd,
    ltv: collateralUsd > 0 ? debtUsd / collateralUsd : 0,
    healthFactor: debtUsd > 0 ? (collateralUsd * p.ltBps) / BPS / debtUsd : Infinity,
    liquidationPrice,
    maxLeverage,
    priceImpact,
    quoteDeviates,
    warning,
    roundTripCostMusd: p.quotedBackMusd !== undefined ? borrowMusd - p.quotedBackMusd : null,
    borrowApy,
    yearlyCarryMusd: debtMusd * borrowApy,
    accountAfter,
    error,
  };
}

export type BtcCloseTerms = {
  collateralBtc: number;
  debtMusd: number;
  /** MUSD the pool quotes for selling all `collateralBtc`: its average price is a safe estimate for selling part. */
  quotedMusdForAll: number;
  slippageBps?: number;
  /** A quote for selling `sellBtc` (this plan's first pass): sizes the sale at that amount's own average price. */
  quote?: { sellBtc: number; musd: number };
  /** Oracle prices, to flag a quote far from them (default threshold QUOTE_DEVIATION_BPS). */
  btcPrice?: number;
  musdPrice?: number;
  maxDeviationBps?: number;
  /**
   * The rest of the account without the MUSD debt and the BTC (USD, valued like VaultManager), when it owes anything
   * else: the close withdraws all the BTC, so that debt must stay within the other collateral's borrow limit, and its
   * risk check needs usable prices (`debtPriced` false: one of those debts has none).
   */
  rest?: { debtUsd: number; borrowLimitUsd: number; debtPriced: boolean };
};

export type BtcClosePlan = {
  /** BTC sold for MUSD: enough for the debt, the buffer and the slippage at the quoted average price. */
  sellBtc: number;
  /** Least MUSD the sale must raise (the debt and buffer, within the slippage of the quote). */
  minProceeds: number;
  collateralBack: number;
  /** MUSD returned beyond the debt (estimate). */
  musdBack: number;
  /** Shortfall of the quote's average price against the oracle (0.02 = Tigris pays 2% less); 0 without `btcPrice`. */
  priceGap: number;
  quoteDeviates: boolean;
  warning: string | null;
  /** Debt remains in another market, so withdrawing the BTC runs the risk check and needs fresh prices. */
  needsPrices: boolean;
  error: string | null;
};

/**
 * SwapLeverageManager.close preview for a full close: the debt (clamped on-chain to the live debt, no flash fee)
 * is repaid from a sale of part of the BTC, and the rest comes back. Run it once with `quotedMusdForAll`, then
 * again with `quote` for the first pass's `sellBtc` to size the sale at its own price. With no debt elsewhere the
 * close needs no price at all.
 */
export function planBtcClose(p: BtcCloseTerms): BtcClosePlan {
  const owed = p.debtMusd;
  const target = owed * (1 + CLOSE_BUFFER_BPS / BPS);
  const slippage = (p.slippageBps ?? 0) / BPS;
  const refined = p.quote && p.quote.sellBtc > 0 && p.quote.musd > 0 ? p.quote : null;
  const avgPrice = refined ? refined.musd / refined.sellBtc : p.collateralBtc > 0 ? p.quotedMusdForAll / p.collateralBtc : 0;
  // On the pool's curve a smaller sale fetches a better average price, so sizing at a larger sale's average never falls short.
  const sellBtc = avgPrice > 0 ? Math.min(p.collateralBtc, (target * (1 + slippage)) / avgPrice) : p.collateralBtc;
  const expected = sellBtc * avgPrice;
  const minProceeds = Math.max(owed, Math.min(target, expected * (1 - slippage)));

  const priceGap = p.btcPrice && p.btcPrice > 0 && avgPrice > 0 ? 1 - (avgPrice * (p.musdPrice ?? 1)) / p.btcPrice : 0;
  const quoteDeviates = Math.abs(priceGap) * BPS > (p.maxDeviationBps ?? QUOTE_DEVIATION_BPS);
  const warning = !quoteDeviates
    ? null
    : priceGap > 0
      ? `Tigris pays ${percent(priceGap)} less than the oracle BTC price: closing now sells your BTC below the price it is valued at`
      : `Tigris pays ${percent(-priceGap)} more than the oracle BTC price: the pool is off the market and its quote may move before the close lands`;

  const rest = p.rest;
  const otherDebt = rest !== undefined && (rest.debtUsd > 0 || !rest.debtPriced);
  let error: string | null = null;
  if (!(owed > 0)) error = 'There is no MUSD debt to repay';
  else if (p.quotedMusdForAll < owed) error = 'There is not enough collateral value to repay the debt';
  else if (otherDebt && !rest.debtPriced) error = 'Another debt has no usable price right now, so the BTC cannot be withdrawn: repay it first';
  else if (otherDebt && rest.debtUsd > rest.borrowLimitUsd)
    error = `Your other debt ($${amount(rest.debtUsd)}) relies on this BTC as collateral: repay it before closing`;

  return {
    sellBtc,
    minProceeds,
    collateralBack: p.collateralBtc - sellBtc,
    musdBack: Math.max(0, expected - owed),
    priceGap,
    quoteDeviates,
    warning,
    needsPrices: otherDebt,
    error,
  };
}
