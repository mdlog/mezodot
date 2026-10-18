import { useState } from 'react';
import { ArrowRight, Check, Shield, TriangleAlert, Undo2, Zap } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, parseAmount, perSecondToAnnual, planBtcClose, planBtcLeverage } from '@mezodot/sdk';
import { TokenLogo } from '../components/Logos';
import { AmountInput, ConnectGate, PanelTitle, PriceNotice } from '../components/ui';
import { HUB } from '../chain/env';
import { btcCloseSteps, btcLeverageSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { useHubClient, useTigrisQuote, useValuedPosition, useWalletBalances } from '../data/hooks';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { BTC_GAS_RESERVE, spendableBtc } from '../lib/btc';
import { fmt, fmtApy, fmtHealth, money, pct, units } from '../lib/format';

const LEVERAGE_OPTIONS = [1.5, 2, 2.5, 3];
/** Swap tolerance the transaction accepts below the router quote. */
const SLIPPAGE_BPS = 50;

/**
 * Long BTC with leverage in one transaction (SwapLeverageManager): flash-borrow MUSD, buy BTC on the Tigris
 * MUSD/BTC pool, post it with your BTC and borrow the MUSD back. Close reverses it.
 */
export function BtcLeverage() {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const { valued, protocol, position, prices, unpriced, relayError } = useValuedPosition();
  const balances = useWalletBalances().data;
  const [amount, setAmount] = useState('0.005');
  const [leverage, setLeverage] = useState(2);
  const [opened, setOpened] = useState<string | null>(null);

  const deployed = Boolean(HUB.deployment?.contracts.swapLeverageManager);
  const btc = protocol?.collaterals.find((c) => !c.isRemote && !c.isShare && c.symbol === 'BTC');
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const btcPrice = prices?.BTC ?? 0;
  const musdPrice = prices?.MUSD ?? 0;
  const terms = { btcPrice, musdPrice, ltvBps: btc?.ltvBps ?? 7_000, ltBps: btc?.ltBps ?? 7_800 };
  const principal = parseAmount(amount) ?? 0;
  const principalWei = btc ? parseInput(amount, btc.decimals) : null;

  // The oracle-priced draft sets how much MUSD to borrow; the DEX quote for it sets the BTC the swap returns.
  const draft = planBtcLeverage({ ...terms, principal, leverage });
  const borrowWei = musd ? floorUnits(draft.borrowMusd, musd.decimals) : 0n;
  const quote = useTigrisQuote(musd?.asset, btc?.token, borrowWei).data;
  const quotedBtc = quote !== undefined && btc ? units(quote, btc.decimals) : undefined;
  const plan = planBtcLeverage({ ...terms, principal, leverage, quotedBtc, slippageBps: SLIPPAGE_BPS });

  const walletBtc = balances?.hub.tokens.BTC ?? 0n;
  const spendable = spendableBtc(walletBtc);
  const overBalance = principalWei !== null && principalWei > spendable;
  const liquidity = musd ? units(musd.cash, musd.decimals) : 0;
  const overLiquidity = plan.borrowMusd > liquidity;
  const borrowApy = musd ? perSecondToAnnual(musd.borrowRatePerSecond) : 0;
  const yearlyCost = plan.debtMusd * musdPrice * borrowApy;

  // An open position: BTC posted against MUSD debt.
  const btcRow = valued?.collateral.find((c) => c.collateral.id === btc?.id);
  const musdDebt = valued?.debts.find((d) => d.market.symbol === 'MUSD');
  const hasPosition = (btcRow?.balance ?? 0n) > 0n && (musdDebt?.amount ?? 0n) > 0n;
  const closeQuote = useTigrisQuote(btc?.token, musd?.asset, hasPosition ? (btcRow?.balance ?? 0n) : 0n).data;
  const closePlan =
    hasPosition && closeQuote !== undefined && musd && btcRow && musdDebt
      ? planBtcClose({
          collateralBtc: btcRow.units,
          debtMusd: units(musdDebt.amount, musd.decimals),
          quotedMusdForAll: units(closeQuote, musd.decimals),
          slippageBps: SLIPPAGE_BPS,
        })
      : null;
  const positionLiqPrice =
    hasPosition && btcRow && musdDebt && btc
      ? (musdDebt.valueUsd - ((valued?.adjustedCollateralUsd ?? 0) - (btcRow.valueUsd * btc.ltBps) / 10_000)) / ((btcRow.units * btc.ltBps) / 10_000)
      : 0;

  const ctx = address && hub && protocol ? { account: address, hub, protocol, position: position ?? null } : null;
  const blocked = !deployed || !btc || !musd || !ctx || plan.error !== null || principalWei === null || quote === undefined || overBalance || overLiquidity;

  const open = async () => {
    if (blocked || !btc || !ctx || principalWei === null) return;
    const steps = btcLeverageSteps(ctx, btc, principalWei, borrowWei, floorUnits(plan.minBoughtBtc, btc.decimals), position?.isSwapLeverageOperator ?? false);
    const result = await run(`${leverage}× BTC`, steps);
    if (result.ok) setOpened(result.receipts[result.receipts.length - 1].transactionHash);
  };

  const close = async () => {
    if (!ctx || !btc || !closePlan || closePlan.error) return;
    // The contract makes the sale cover the flash loan; the unsold BTC comes back untouched.
    await run('Close BTC leverage', btcCloseSteps(ctx, floorUnits(closePlan.sellBtc, btc.decimals), 0n));
  };

  const trace = [
    { n: '01', title: 'Flash borrow MUSD from MezodotPool', amount: money(plan.borrowMusd, 2) },
    { n: '02', title: 'Swap MUSD → BTC on Tigris', amount: `${fmt(plan.boughtBtc, 6)} BTC` },
    { n: '03', title: 'Post your BTC + bought BTC', amount: `${fmt(plan.postedBtc, 6)} BTC` },
    { n: '04', title: 'Borrow MUSD, repay flash + fee', amount: money(plan.debtMusd, 2) },
  ];

  if (!deployed) {
    return (
      <p className="inline-error" role="status">
        BTC leverage is not deployed on {HUB.label} yet: it ships with the next hub deployment (SwapLeverageManager on Tigris).
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
                Wallet · {btc ? fmt(units(walletBtc, btc.decimals), 6) : '—'} BTC (keeps {fmt(units(BTC_GAS_RESERVE, 18), 4)} for gas)
              </span>
            </label>
            <AmountInput
              id="btc-amount"
              large
              value={amount}
              onChange={setAmount}
              unit="BTC"
              onMax={() => btc && setAmount(toInput(spendable, btc.decimals))}
            />
          </div>
          <div className="form-section">
            <div className="field-label">
              TARGET LEVERAGE{' '}
              <span>
                {leverage.toFixed(2)}× · max {plan.maxLeverage.toFixed(2)}× at {(btc?.ltvBps ?? 7000) / 100}% LTV
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
          <PriceNotice unpriced={unpriced} relayError={relayError} />
          <ConnectGate connected={isConnected}>
            <button className="button button--dark button--wide" onClick={open} disabled={blocked || Boolean(busy)}>
              {busy ?? (
                <>
                  <Zap size={15} /> Open {leverage}× BTC <ArrowRight size={15} />
                </>
              )}
            </button>
          </ConnectGate>
          {(plan.error || overBalance || overLiquidity) && (
            <p className="inline-error" role="alert">
              {plan.error ??
                (overBalance
                  ? `Amount exceeds the BTC you can commit: at most ${btc ? fmt(units(spendable, btc.decimals), 6) : '0'} BTC after the gas reserve`
                  : 'Not enough MUSD liquidity in the pool for the flash loan')}
            </p>
          )}
          {quote === undefined && principal > 0 && !plan.error && <p className="muted-note">Fetching a Tigris quote…</p>}
          <div className="small-disclosure">
            <Shield size={14} /> First time: one extra transaction authorises SwapLeverageManager as your VaultManager operator, and one approves BTC.
          </div>
        </section>

        <div className="loop-side">
          <section className="panel loop-projection">
            <div className="projection-head">
              <span className="overline">POSITION PREVIEW</span>
              <span className="projection-tag">TIGRIS QUOTE · {SLIPPAGE_BPS / 100}% SLIPPAGE</span>
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
                <span>Liquidation price</span>
                <b className="tone-warn">{money(plan.liquidationPrice, 0)}</b>
              </div>
              <div>
                <span>Price impact</span>
                <b className={plan.priceImpact > 0.01 ? 'tone-danger' : ''}>{pct(Math.max(0, plan.priceImpact), 2)}</b>
              </div>
              <div>
                <span>Borrow cost / year</span>
                <b>
                  {money(yearlyCost, 2)} <small>({fmtApy(borrowApy)})</small>
                </b>
              </div>
            </div>
            <div className="projection-foot">
              <TriangleAlert size={14} />
              <span>
                BTC earns nothing here: the position costs the MUSD borrow rate and two 0.09% flash fees (open and close). It gains if BTC rises faster than
                that, and is liquidated if BTC falls to {money(plan.liquidationPrice, 0)} (BTC now {money(btcPrice, 0)}).
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
              <span>LTV / HEALTH</span>
              <b className={`tone-${healthStatus(plan.healthFactor).tone}`}>
                {pct(plan.ltv)} · {fmtHealth(plan.healthFactor)}
              </b>
              <span>DEBT (INCL. FEE)</span>
              <b>{money(plan.debtMusd, 2)}</b>
            </div>
          </section>

          {hasPosition && btcRow && musdDebt && (
            <section className="panel open-loop-panel">
              <PanelTitle label="Open BTC position" meta="Counts toward account health" />
              <div className="risk-math">
                <span>
                  <TokenLogo symbol="BTC" size={16} /> BTC collateral{' '}
                  <b>
                    {fmt(btcRow.units, 6)} BTC · {money(btcRow.valueUsd, 2)}
                  </b>
                </span>
                <span>
                  MUSD debt <b>{money(musdDebt.valueUsd, 2)}</b>
                </span>
                <span>
                  Liquidation price <b className="tone-warn">{money(positionLiqPrice, 0)}</b>
                </span>
                <span>
                  Account health <b>{fmtHealth(valued!.healthFactor)}</b>
                </span>
              </div>
              <button className="button button--light button--wide" onClick={close} disabled={!closePlan || closePlan.error !== null || Boolean(busy)}>
                <Undo2 size={14} />{' '}
                {busy ??
                  (closePlan
                    ? `Close: repay all MUSD debt, sell ≈ ${fmt(closePlan.sellBtc, 6)} BTC, get ≈ ${fmt(closePlan.collateralBack, 6)} BTC back`
                    : 'Quoting…')}
              </button>
              {closePlan?.error && <p className="inline-error">{closePlan.error}</p>}
              <p className="muted-note">Closing repays every MUSD debt on the account (including other positions) and withdraws all posted BTC.</p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
