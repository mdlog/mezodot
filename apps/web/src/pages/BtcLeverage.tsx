import { useState } from 'react';
import { maxUint256 } from 'viem';
import { ArrowRight, Check, Shield, TriangleAlert, Undo2, Zap } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  borrowRoomAt,
  healthStatus,
  marketPoolState,
  MAX_QUOTE_SHORTFALL_BPS,
  maxBtcPrincipal,
  parseAmount,
  perSecondToApy,
  planBtcClose,
  planBtcLeverage,
  type BtcCloseTerms,
  type BtcLeverageTerms,
} from '@mezodot/sdk';
import { TokenLogo } from '../components/Logos';
import { HubPending } from '../components/StatusBanners';
import { AmountInput, ConnectGate, PanelTitle, PriceNotice } from '../components/ui';
import { HUB } from '../chain/env';
import { btcCloseSteps, btcLeverageSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { borrowBlocked, collateralRoom, postBlocked, useHubFlags } from '../data/guards';
import { readError, useHubClient, useTigrisPoolQuote, useValuedPosition, useWalletBalances } from '../data/hooks';
import { ceilUnits, floorUnits, parseInput, roundedInput, toInput } from '../lib/amount';
import { BTC_GAS_RESERVE, spendableBtc } from '../lib/btc';
import { fmt, fmtApy, fmtHealth, money, pct, tokenAmount, units } from '../lib/format';

const LEVERAGE_OPTIONS = [1.5, 2, 2.5, 3];
/** Swap tolerance the transaction accepts below the Tigris quote. */
const SLIPPAGE_BPS = 50;
/** MAX and the suggested amount use this share of what the MUSD pool can lend, leaving room for other borrowers before inclusion. */
const LIQUIDITY_USE = 0.98;
/** Smallest principal worth suggesting (BTC); below it the desk says what blocks the position instead. */
const MIN_SUGGESTED_BTC = 1e-6;

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

/** How the Tigris quote compares with the oracle price, signed: fewer BTC means buying above the oracle. */
function quoteGap(priceImpact: number): string {
  if (Math.abs(priceImpact) < 0.00005) return 'at the oracle price';
  return priceImpact > 0 ? `${pct(priceImpact, 2)} fewer BTC` : `${pct(-priceImpact, 2)} more BTC`;
}

/**
 * Long BTC with leverage in one transaction (SwapLeverageManager): a Tigris flash swap sends the BTC first, it is
 * posted with yours, and the MUSD borrowed against it pays the pool. The debt is exactly the borrow (no flash fee),
 * and the MUSD pool only needs that much idle cash. Close reverses it with a sale that repays the live debt.
 */
export function BtcLeverage() {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const { valued, protocol, position, prices, unpriced, unpricedDebts, relayError } = useValuedPosition();
  const balances = useWalletBalances().data;
  const flags = useHubFlags().data;
  // null: follow the suggested amount (sized to the MUSD pool, see below).
  const [typed, setTyped] = useState<string | null>(null);
  const [leverage, setLeverage] = useState(2);
  const [opened, setOpened] = useState<string | null>(null);

  const deployed = Boolean(HUB.deployment?.contracts.swapLeverageManager);
  const pairDeployed = Boolean(HUB.deployment?.contracts.tigrisPool);
  const btc = protocol?.collaterals.find((c) => !c.isRemote && !c.isShare && c.symbol === 'BTC');
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const btcPrice = prices?.BTC ?? 0;
  const musdPrice = prices?.MUSD ?? 0;
  const btcRow = valued?.collateral.find((c) => c.collateral.id === btc?.id);
  const capRoom = btc ? collateralRoom(btc) : maxUint256;

  const terms: Omit<BtcLeverageTerms, 'principal' | 'leverage'> = {
    btcPrice,
    musdPrice,
    ltvBps: btc?.ltvBps ?? 7_000,
    ltBps: btc?.ltBps ?? 7_800,
    slippageBps: SLIPPAGE_BPS,
    // The MUSD pool lends the borrow from its idle cash: checks cash and caps, and prices the carry once it is lent.
    pool: musd ? (marketPoolState(musd) ?? undefined) : undefined,
    borrowApy: musd ? perSecondToApy(musd.borrowRatePerSecond) : 0,
    // The whole account VaultManager checks; the BTC it already holds moves the liquidation price.
    account: valued ? { ...valued, btcUnits: btcRow?.units ?? 0 } : undefined,
    collateralRoom: btc && capRoom !== maxUint256 ? units(capRoom, btc.decimals) : undefined,
  };
  const walletBtc = balances?.hub.tokens.BTC;
  const spendable = spendableBtc(walletBtc ?? 0n);
  // What can be funded with a swap at the oracle price; the quote for an amount resizes it below (plan.maxPrincipal).
  const fundable = maxBtcPrincipal(leverage, terms);
  // The oracle price sets the MUSD to borrow; the pool's own quote for it sets the BTC the flash swap delivers.
  const borrowWeiFor = (principal: number) => (musd ? floorUnits(planBtcLeverage({ ...terms, principal, leverage }).borrowMusd, musd.decimals) : 0n);
  // Suggested: the largest round amount that keeps the MUSD pool at or below its kink (borrow rates jump past it),
  // within what can be funded at all and what the wallet can commit.
  const atKink =
    terms.pool && btcPrice > 0 && musdPrice > 0 ? (borrowRoomAt(terms.pool, terms.pool.model.kink) * musdPrice) / (btcPrice * (leverage - 1)) : Infinity;
  const walletUnits = btc && walletBtc !== undefined && spendable > 0n ? units(spendable, btc.decimals) : Infinity;
  const draft =
    btc && btcPrice > 0 && musdPrice > 0
      ? roundedInput(Math.min(atKink >= MIN_SUGGESTED_BTC ? Math.min(atKink, fundable) : fundable, walletUnits) * LIQUIDITY_USE)
      : '';
  // The swap may return fewer BTC than the oracle price implies: while suggesting, a quote for the draft resizes it at
  // the BTC Tigris pays (that quote depends only on the draft, so the suggestion settles in one step).
  const draftPrincipal = parseAmount(draft) ?? 0;
  const draftBorrowWei = typed === null ? borrowWeiFor(draftPrincipal) : 0n;
  const draftQuote = useTigrisPoolQuote(musd?.asset, draftBorrowWei).data;
  const draftPlan =
    draftQuote !== undefined && btc && musd
      ? planBtcLeverage({ ...terms, principal: draftPrincipal, leverage, quotedBtc: units(draftQuote, btc.decimals) })
      : null;
  const suggested = draftPlan?.error && draftPlan.maxPrincipal * LIQUIDITY_USE < draftPrincipal ? roundedInput(draftPlan.maxPrincipal * LIQUIDITY_USE) : draft;
  const amount = typed ?? suggested;
  const principal = parseAmount(amount) ?? 0;
  const principalWei = btc ? parseInput(amount, btc.decimals) : null;

  const borrowWei = borrowWeiFor(principal);
  const buy = useTigrisPoolQuote(musd?.asset, borrowWei);
  // Selling that BTC straight back prices the round trip.
  const sellBack = useTigrisPoolQuote(btc?.token, buy.data ?? 0n);
  const plan = planBtcLeverage({
    ...terms,
    principal,
    leverage,
    quotedBtc: buy.data !== undefined && btc ? units(buy.data, btc.decimals) : undefined,
    quotedBackMusd: sellBack.data !== undefined && musd ? units(sellBack.data, musd.decimals) : undefined,
  });
  const after = plan.accountAfter;

  const overBalance = principalWei !== null && walletBtc !== undefined && principalWei > spendable;
  // What the pool, the caps and the borrow limit fund at this amount's quote (the oracle price until it is quoted).
  const fundableNow = plan.maxPrincipal;
  // MAX: what the wallet can commit, capped at that (exact base units).
  // Past the quote-shortfall gate this size is refused whatever the pool funds: MAX must not fill in an amount the
  // desk itself rejects (a smaller amount moves the pool less and may pass).
  const quoteTooShort = plan.priceImpact * 10_000 > MAX_QUOTE_SHORTFALL_BPS;
  const maxWei = (() => {
    if (!btc || walletBtc === undefined || quoteTooShort) return null;
    return Number.isFinite(fundableNow) ? minBig(spendable, floorUnits(fundableNow * LIQUIDITY_USE, btc.decimals)) : spendable;
  })();

  const ctx = address && hub && protocol ? { account: address, hub, protocol, position: position ?? null } : null;
  // First reason the position cannot be opened now; null when it can.
  const openBlocked =
    plan.error ??
    (btc ? postBlocked(btc) : null) ??
    (musd ? borrowBlocked(musd, flags) : null) ??
    (overBalance && btc ? `Amount exceeds the BTC you can commit: at most ${fmt(units(spendable, btc.decimals), 6)} BTC after the gas reserve` : null) ??
    (!pairDeployed ? 'This deployment names no Tigris MUSD/BTC pool to quote' : null) ??
    (buy.error ? `No Tigris quote right now: ${readError(buy.error)}` : null);
  const quoting = principal > 0 && openBlocked === null && buy.data === undefined;
  // With no amount suggested because nothing fits, say why (what a nominal position runs into, or what the draft
  // amount runs into at its quote) rather than asking for one.
  const shownBlock =
    amount.trim() !== ''
      ? openBlocked
      : fundable < MIN_SUGGESTED_BTC && btcPrice > 0
        ? planBtcLeverage({ ...terms, principal: 0.0001, leverage }).error
        : (draftPlan?.error ?? null);
  const canOpen =
    deployed &&
    ctx !== null &&
    btc !== undefined &&
    openBlocked === null &&
    unpricedDebts.length === 0 &&
    principalWei !== null &&
    buy.data !== undefined &&
    walletBtc !== undefined &&
    !busy;

  // An open position: BTC posted against MUSD debt, read from the position itself (closing needs no price).
  const postedWei = btc ? (position?.collateral.find((c) => c.id === btc.id)?.balance ?? 0n) : 0n;
  const debtWei = musd ? (position?.debts.find((d) => d.marketId === musd.id)?.amount ?? 0n) : 0n;
  const hasPosition = postedWei > 0n && debtWei > 0n;
  const postedBtc = btc ? units(postedWei, btc.decimals) : 0;
  const debtMusd = musd ? units(debtWei, musd.decimals) : 0;
  const musdDebtRow = valued?.debts.find((d) => d.market.id === musd?.id);
  // Debt in other markets must stay covered once all the BTC leaves; valuing it needs prices (null: not loaded).
  const otherDebt = position?.debts.some((d) => d.marketId !== musd?.id && d.amount > 0n) ?? false;
  const rest: BtcCloseTerms['rest'] | null = !otherDebt
    ? undefined
    : valued
      ? {
          debtUsd: valued.debtUsd - (musdDebtRow?.valueUsd ?? 0),
          // The BTC's share of the limit: only while it is enabled and priced (VaultManager's conservative mode).
          borrowLimitUsd: valued.borrowLimitUsd - (btc?.enabled && btcRow?.priced ? (btcRow.valueUsd * btc.ltvBps) / 10_000 : 0),
          debtPriced: valued.debts.every((d) => d.market.id === musd?.id || d.amount === 0n || d.priced),
        }
      : null;
  const sellAll = useTigrisPoolQuote(btc?.token, hasPosition ? postedWei : 0n).data;
  const closeTerms: BtcCloseTerms | null =
    hasPosition && btc && musd && sellAll !== undefined && rest !== null
      ? {
          collateralBtc: postedBtc,
          debtMusd,
          quotedMusdForAll: units(sellAll, musd.decimals),
          slippageBps: SLIPPAGE_BPS,
          // Usable prices only, to flag a quote far off the market: a lapsed MUSD feed leaves nothing to compare against.
          btcPrice: prices?.BTC,
          musdPrice: prices?.MUSD,
          rest,
        }
      : null;
  const draftClose = closeTerms ? planBtcClose(closeTerms) : null;
  // Second pass: size the sale at the average price of the amount actually sold (a smaller sale fetches more per BTC).
  const draftSellWei = draftClose && btc ? minBig(ceilUnits(draftClose.sellBtc, btc.decimals), postedWei) : 0n;
  const draftSellQuote = useTigrisPoolQuote(btc?.token, draftSellWei).data;
  const closePlan =
    !closeTerms || !draftClose || !btc || !musd
      ? null
      : draftSellWei === 0n
        ? draftClose
        : draftSellQuote === undefined
          ? null
          : planBtcClose({ ...closeTerms, quote: { sellBtc: units(draftSellWei, btc.decimals), musd: units(draftSellQuote, musd.decimals) } });
  const sellWei = closePlan && btc ? minBig(ceilUnits(closePlan.sellBtc, btc.decimals), postedWei) : 0n;
  const positionLiqPrice =
    hasPosition && valued && btcRow && btc && btcRow.units > 0
      ? Math.max(0, (valued.debtUsd - (valued.adjustedCollateralUsd - (btcRow.valueUsd * btc.ltBps) / 10_000)) / ((btcRow.units * btc.ltBps) / 10_000))
      : null;

  const open = async () => {
    if (!canOpen || !btc || !ctx || principalWei === null) return;
    const steps = btcLeverageSteps(ctx, btc, principalWei, borrowWei, floorUnits(plan.minBoughtBtc, btc.decimals), position?.isSwapLeverageOperator ?? false);
    const result = await run(`${leverage}× BTC`, steps);
    if (result.ok) setOpened(result.receipts[result.receipts.length - 1].transactionHash);
  };

  const close = async () => {
    if (!ctx || !btc || !musd || !closePlan || closePlan.error || sellWei === 0n) return;
    // The contract repays the live debt (clamped) and makes the sale cover it; the unsold BTC comes back untouched.
    const steps = btcCloseSteps(ctx, sellWei, floorUnits(closePlan.minProceeds, musd.decimals), position?.isSwapLeverageOperator ?? false);
    await run('Close BTC leverage', steps);
  };

  const trace = [
    { n: '01', title: 'Flash swap: Tigris sends the BTC first', amount: `${fmt(plan.boughtBtc, 6)} BTC` },
    { n: '02', title: 'Post your BTC + the bought BTC', amount: `${fmt(plan.postedBtc, 6)} BTC` },
    { n: '03', title: 'Borrow MUSD straight to the pool as payment', amount: tokenAmount(plan.borrowMusd, 'MUSD') },
    { n: '04', title: 'Pool checks it was paid · no flash fee', amount: 'Same transaction' },
  ];
  const carryOnEquity = principal > 0 && btcPrice > 0 ? (plan.yearlyCarryMusd * musdPrice) / (principal * btcPrice) : 0;

  if (!deployed) {
    return (
      <p className="inline-error" role="status">
        BTC leverage is not deployed on {HUB.label} yet: it ships with the next hub deployment (SwapLeverageManager on Tigris).
      </p>
    );
  }
  // Waiting on (or failing) the hub read: say which, instead of a form of zeros.
  if (!protocol) {
    return (
      <section className="panel loop-config-panel">
        <PanelTitle label="Configure your BTC position" meta="BTC long · MUSD debt · Tigris" />
        <HubPending what="the MUSD pool and BTC collateral" />
      </section>
    );
  }
  if (!btc || !musd) {
    return (
      <p className="inline-error" role="status">
        BTC leverage needs BTC collateral and the MUSD market, and this hub deployment does not list both.
      </p>
    );
  }

  return (
    <>
      <div className="loop-layout">
        <section className="panel loop-config-panel">
          <PanelTitle label="Configure your BTC position" meta="BTC long · MUSD debt · Tigris" />
          <div className="form-section">
            <label className="field-label" htmlFor="btc-amount">
              YOUR BTC{' '}
              <span>
                Wallet · {walletBtc !== undefined ? fmt(units(walletBtc, btc.decimals), 6) : '—'} BTC (keeps {fmt(units(BTC_GAS_RESERVE, 18), 4)} for gas)
                {terms.pool && Number.isFinite(fundableNow) && !quoteTooShort && unpricedDebts.length === 0
                  ? ` · pool funds ≤ ${fmt(fundableNow, 6)} at ${leverage}×`
                  : ''}
              </span>
            </label>
            <AmountInput
              id="btc-amount"
              large
              value={amount}
              onChange={setTyped}
              unit="BTC"
              onMax={() => maxWei !== null && setTyped(toInput(maxWei, btc.decimals))}
            />
          </div>
          <div className="form-section">
            <div className="field-label">
              TARGET LEVERAGE{' '}
              <span>
                {leverage.toFixed(2)}× · max {plan.maxLeverage.toFixed(2)}× at {btc.ltvBps / 100}% LTV
              </span>
            </div>
            <div className="leverage-selector">
              {LEVERAGE_OPTIONS.map((v) => (
                <button key={v} className={leverage === v ? 'is-selected' : ''} onClick={() => setLeverage(v)} aria-pressed={leverage === v}>
                  {v}×
                </button>
              ))}
            </div>
            <div className="slider-shell">
              <input
                aria-label="Leverage target"
                type="range"
                min="1.1"
                max="3.2"
                step="0.1"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
              />
            </div>
          </div>
          <PriceNotice unpriced={unpriced} relayError={relayError} unpricedDebts={unpricedDebts} />
          <ConnectGate connected={isConnected}>
            <button className="button button--dark button--wide" onClick={open} disabled={!canOpen}>
              {busy ?? (
                <>
                  <Zap size={15} /> Open {leverage}× BTC <ArrowRight size={15} />
                </>
              )}
            </button>
          </ConnectGate>
          {shownBlock && (
            <p className="inline-error" role="alert">
              {shownBlock}
            </p>
          )}
          {quoting && <p className="muted-note">Fetching a Tigris quote…</p>}
          {plan.warning && (
            <div className="message-warning" role="status">
              <TriangleAlert size={14} /> {plan.warning}.
            </div>
          )}
          <div className="small-disclosure">
            <Shield size={14} />{' '}
            {position?.isSwapLeverageOperator
              ? 'BTC is approved to SwapLeverageManager only when your allowance is too low.'
              : 'First time: one extra transaction authorises SwapLeverageManager as your VaultManager operator, and one approves BTC.'}
          </div>
        </section>

        <div className="loop-side">
          <section className="panel loop-projection">
            <div className="projection-head">
              <span className="overline">POSITION PREVIEW</span>
              <span className="projection-tag">
                {buy.data !== undefined ? `TIGRIS QUOTE · ${SLIPPAGE_BPS / 100}% SLIPPAGE` : 'ORACLE PRICE · NO QUOTE YET'}
              </span>
            </div>
            <div className="projection-value">
              <div>
                <small>BTC EXPOSURE</small>
                <strong>
                  {fmt(plan.postedBtc, 6)} <small>BTC</small>
                </strong>
              </div>
              <div className="projection-multiplier">{leverage.toFixed(2)}×</div>
            </div>
            <div className="projection-metrics">
              <div>
                <span>Exposure value</span>
                <b>{money(plan.postedBtc * btcPrice, 2)}</b>
              </div>
              <div>
                <span>Liquidation price{after ? ' (account)' : ''}</span>
                <b className="tone-warn">{money(plan.liquidationPrice, 0)}</b>
              </div>
              <div>
                <span>Tigris vs oracle</span>
                <b className={plan.quoteDeviates ? 'tone-danger' : ''}>{buy.data !== undefined && btcPrice > 0 ? quoteGap(plan.priceImpact) : '—'}</b>
              </div>
              <div>
                <span>Round trip at today's quotes</span>
                <b>
                  {plan.roundTripCostMusd === null ? (
                    '—'
                  ) : (
                    <>
                      {tokenAmount(plan.roundTripCostMusd, 'MUSD')}{' '}
                      <small>{pct(plan.borrowMusd > 0 ? plan.roundTripCostMusd / plan.borrowMusd : 0, 2)} of the swap</small>
                    </>
                  )}
                </b>
              </div>
              <div>
                <span>Borrow APY once open</span>
                <b>{fmtApy(plan.borrowApy)}</b>
              </div>
              <div>
                <span>MUSD carry / year</span>
                <b>
                  {tokenAmount(plan.yearlyCarryMusd, 'MUSD')} <small>{pct(carryOnEquity, 2)} of your BTC</small>
                </b>
              </div>
            </div>
            <div className="projection-foot">
              <TriangleAlert size={14} />
              <span>
                BTC earns nothing here: the position pays the MUSD borrow rate ({fmtApy(plan.borrowApy)} once this borrow is lent out) and the Tigris swap fee
                on the way in and out; there is no flash fee. It gains if BTC rises faster than that, and is liquidated if BTC falls to{' '}
                {money(plan.liquidationPrice, 0)} (BTC now {money(btcPrice, 0)}).
              </span>
            </div>
          </section>

          <section className="panel trace-panel">
            <PanelTitle label="Atomic execution trace" meta="SwapLeverageManager.open" />
            <div className="trace-list">
              {trace.map((item) => (
                <div className={`trace-item ${opened ? 'trace-item--active' : ''}`} key={item.n}>
                  <span>{opened ? <Check size={11} /> : item.n}</span>
                  <b>{item.title}</b>
                  <small>{item.amount}</small>
                </div>
              ))}
            </div>
            <div className="trace-summary">
              <span>{after ? 'ACCOUNT LTV / HEALTH AFTER' : 'LTV / HEALTH'}</span>
              <b className={`tone-${healthStatus(after?.healthFactor ?? plan.healthFactor).tone}`}>
                {pct(after?.ltv ?? plan.ltv)} · {fmtHealth(after?.healthFactor ?? plan.healthFactor)}
              </b>
              <span>DEBT (THE BORROW, NO FEE)</span>
              <b>{tokenAmount(plan.debtMusd, 'MUSD')}</b>
            </div>
          </section>

          {hasPosition && (
            <section className="panel open-loop-panel">
              <PanelTitle label="Open BTC position" meta="Counts toward account health" />
              <div className="risk-math">
                <span>
                  <TokenLogo symbol="BTC" size={16} /> BTC collateral{' '}
                  <b>
                    {fmt(postedBtc, 6)} BTC{btcRow ? ` · ${money(btcRow.valueUsd, 2)}` : ''}
                  </b>
                </span>
                <span>
                  MUSD debt <b>{tokenAmount(debtMusd, 'MUSD')}</b>
                </span>
                <span>
                  Liquidation price <b className="tone-warn">{positionLiqPrice === null ? '…' : money(positionLiqPrice, 0)}</b>
                </span>
                <span>
                  Account health <b>{valued ? fmtHealth(valued.healthFactor) : '…'}</b>
                </span>
              </div>
              {closePlan && !closePlan.error && (
                <p className="muted-note">
                  Sells ≈ {fmt(closePlan.sellBtc, 6)} BTC on Tigris to repay the {tokenAmount(debtMusd, 'MUSD')} debt (the sale must raise at least{' '}
                  {tokenAmount(closePlan.minProceeds, 'MUSD')}); ≈ {fmt(closePlan.collateralBack, 6)} BTC and ≈ {tokenAmount(closePlan.musdBack, 'MUSD')} come
                  back.
                </p>
              )}
              {closePlan?.warning && (
                <div className="message-warning" role="status">
                  <TriangleAlert size={14} /> {closePlan.warning}.
                </div>
              )}
              <button
                className="button button--light button--wide"
                onClick={close}
                disabled={!closePlan || closePlan.error !== null || sellWei === 0n || Boolean(busy)}
              >
                <Undo2 size={14} />{' '}
                {busy ??
                  (closePlan
                    ? `Close: repay all MUSD debt, sell ≈ ${fmt(closePlan.sellBtc, 6)} BTC, get ≈ ${fmt(closePlan.collateralBack, 6)} BTC back`
                    : rest === null
                      ? 'Loading prices…'
                      : 'Quoting…')}
              </button>
              {closePlan?.error && <p className="inline-error">{closePlan.error}</p>}
              <p className="muted-note">
                Closing repays every MUSD debt on the account (including other positions) and withdraws all posted BTC. The Tigris sale funds the repayment, so
                it needs no MUSD pool cash and no flash fee{otherDebt ? '' : ', and no fresh price'}.
                {!position?.isSwapLeverageOperator && ' First time: one extra transaction authorises SwapLeverageManager as your VaultManager operator.'}
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
