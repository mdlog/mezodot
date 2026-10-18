import { useState } from 'react';
import { maxUint256 } from 'viem';
import { ArrowRight, Check, Shield, Sparkles, TriangleAlert, Undo2, Zap } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  BPS,
  FLASH_FEE_BPS,
  healthStatus,
  marketPoolState,
  maxLoopPrincipal,
  parseAmount,
  perSecondToApy,
  planLoop,
  planUnwind,
  pTokenUnits,
  type LoopTerms,
  type UnwindPlan,
  type UnwindTerms,
} from '@mezodot/sdk';
import { HubPending } from '../components/StatusBanners';
import { AmountInput, ConnectGate, NotDeployed, PageTitle, PanelTitle, PriceNotice, SummaryStrip } from '../components/ui';
import { HUB, HUB_DEPLOYED } from '../chain/env';
import { loopSteps, unwindSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { borrowBlocked, collateralRoom, useHubFlags } from '../data/guards';
import { useHubClient, useValuedPosition, useWalletBalances } from '../data/hooks';
import { floorUnits, parseInput, roundedInput, toInput } from '../lib/amount';
import { fmt, fmtApy, fmtHealth, pct, tokenAmount, units } from '../lib/format';
import { sharesFor } from '../lib/shares';
import { useUi } from '../state/UiContext';
import { BtcLeverage } from './BtcLeverage';

const LEVERAGE_OPTIONS = [1.5, 2, 2.5, 3, 3.5, 4];
/** Suggested amounts use this share of what the pool can fund, leaving room for other borrowers before inclusion. */
const LIQUIDITY_USE = 0.98;
/** Accepted shortfall of the equity an unwind returns against its preview (interest and rounding). */
const UNWIND_SLIPPAGE_BPS = 50;
/** PRD flow C. */
const SCENARIO = { principal: 1_000, leverage: 3 };
/** MezodotPool's flash-loan fee (a contract constant, mirrored by the SDK), paid to the pool's reserves when a loop opens. */
const FLASH_FEE = pct(FLASH_FEE_BPS / BPS, 2);

type Mode = 'btc' | 'musd';

export function Loop() {
  const [mode, setMode] = useState<Mode>(HUB.deployment?.contracts.swapLeverageManager ? 'btc' : 'musd');
  return (
    <>
      <PageTitle
        eyebrow="CAPITAL / 04"
        title="Leverage desk."
        subtitle={`One-transaction positions on the Mezo Hub: a BTC long through a Tigris flash swap (no flash fee: the debt is exactly the borrow), or a pMUSD supply loop on the MUSD pool's flash loan (${FLASH_FEE} fee to its reserves) that unwinds against your pMUSD with no fee. VaultManager enforces the LTV, so an unsafe position simply reverts.`}
        right={
          <span className="security-pill">
            <Shield size={14} /> ATOMIC ONE-TRANSACTION ROUTE
          </span>
        }
      />
      <SummaryStrip
        snapshot={
          mode === 'btc' ? (
            <>
              SWAPLEVERAGEMANAGER · TIGRIS MUSD/BTC FLASH SWAP <i>/</i> NO FLASH FEE
            </>
          ) : (
            <>
              LEVERAGEMANAGER · pMUSD LOOP <i>/</i> ERC-3156 FLASH LOAN · {FLASH_FEE} FEE TO RESERVES
            </>
          )
        }
        time="One transaction"
        icon={Zap}
      />
      {!HUB_DEPLOYED ? (
        <NotDeployed />
      ) : (
        <>
          <div className="leverage-modes" role="tablist" aria-label="Leverage product">
            {(
              [
                ['btc', 'BTC leverage', 'Long BTC up to ~3× against MUSD debt'],
                ['musd', 'MUSD loop', 'Multiply a pMUSD supply position'],
              ] as const
            ).map(([key, label, hint]) => (
              <button key={key} role="tab" aria-selected={mode === key} className={mode === key ? 'is-active' : ''} onClick={() => setMode(key)}>
                <b>{label}</b>
                <small>{hint}</small>
              </button>
            ))}
          </div>
          {mode === 'btc' ? <BtcLeverage /> : <MusdLoop />}
        </>
      )}
    </>
  );
}

/** What the unwind does, in one sentence. */
function unwindSummary(u: UnwindPlan): string {
  if (u.debtLeft > 0) {
    return `Repays ${tokenAmount(u.netted, 'MUSD')} of debt with all your pMUSD; ${tokenAmount(u.debtLeft, 'MUSD')} stays as debt, backed by your other collateral. Nothing is paid out.`;
  }
  const paid =
    u.withdrawn <= 0
      ? 'withdraws nothing'
      : `pays out ≈ ${tokenAmount(u.out, 'MUSD')}${u.returned > 0 ? ` and returns ≈ ${tokenAmount(u.returned, 'MUSD')} as pMUSD (the pool's idle cash is short; it keeps earning)` : ''}`;
  const kept = u.kept > 0 ? `; ${tokenAmount(u.kept, 'MUSD')} of pMUSD stays posted for your other debt` : '';
  return `Repays all ${tokenAmount(u.netted, 'MUSD')} of debt with pMUSD, then ${paid}${kept}.`;
}

function MusdLoop() {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const { openModal } = useUi();
  const { valued, protocol, position, prices, unpriced, unpricedDebts, relayError } = useValuedPosition();
  const balances = useWalletBalances().data;
  const flags = useHubFlags().data;
  // null: follow the suggested amount (the largest round one the pool can fund at this leverage and the wallet holds).
  const [typed, setTyped] = useState<string | null>(null);
  const [leverage, setLeverage] = useState(SCENARIO.leverage);
  const [lastLoop, setLastLoop] = useState<string | null>(null);

  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const collateral = protocol?.collaterals.find((c) => c.symbol === 'pMUSD');
  const musdPrice = prices?.MUSD;
  const reserveFactor = musd ? Number(musd.reserveFactor) / 1e18 : 0;
  // pMUSD shares the collateral cap still accepts (maxUint256: uncapped), valued in MUSD for the plan.
  const capShares = collateral ? collateralRoom(collateral) : maxUint256;
  const terms: LoopTerms = {
    ltvBps: collateral?.ltvBps ?? 8_000,
    ltBps: collateral?.ltBps ?? 8_500,
    // Used only without the pool's rate model: the carry is otherwise priced at the state the loop leaves.
    supplyApy: musd ? perSecondToApy(musd.supplyRatePerSecond) : 0,
    borrowApy: musd ? perSecondToApy(musd.borrowRatePerSecond) : 0,
    pool: musd ? (marketPoolState(musd) ?? undefined) : undefined,
    // The whole account VaultManager checks: the loop's pMUSD and debt are added to it.
    account: valued ?? undefined,
    musdPrice: musdPrice ?? 1,
    collateralRoom: musd && capShares !== maxUint256 ? pTokenUnits(musd, capShares) : undefined,
  };
  const wallet = balances?.hub.tokens.MUSD;
  const walletUnits = musd && wallet !== undefined && wallet > 0n ? units(wallet, musd.decimals) : Infinity;
  const fundable = (lev: number) => maxLoopPrincipal(lev, terms) * LIQUIDITY_USE;
  const amount = typed ?? (musd ? roundedInput(Math.min(fundable(leverage), walletUnits)) : '');
  const plan = planLoop(parseAmount(amount) ?? 0, leverage, terms);
  const principalWei = musd ? parseInput(amount, musd.decimals) : null;
  const overBalance = principalWei !== null && wallet !== undefined && principalWei > wallet;
  const after = plan.accountAfter;
  // MAX: the wallet balance, capped at what the pool can fund (exact base units, no rounding).
  const maxWei = (() => {
    if (!musd) return null;
    const byPool = Number.isFinite(fundable(leverage)) ? floorUnits(fundable(leverage), musd.decimals) : undefined;
    if (wallet === undefined) return byPool ?? null;
    return byPool !== undefined && byPool < wallet ? byPool : wallet;
  })();

  // First reason the loop cannot be opened now; null when it can.
  const openBlocked =
    plan.error ??
    (collateral && !collateral.enabled ? 'pMUSD is not accepted as new collateral right now, so the loop has nothing to borrow against' : null) ??
    (musd ? borrowBlocked(musd, flags) : null) ??
    (musdPrice === undefined ? "No usable MUSD price right now: the loop's borrow is priced strictly and would revert" : null) ??
    (overBalance ? 'Amount exceeds your MUSD balance' : null);
  const canOpen = openBlocked === null && unpricedDebts.length === 0 && principalWei !== null && !busy;
  // With no amount suggested because nothing fits, say why (what a nominal 1 MUSD loop runs into) rather than asking for one.
  const shownBlock = amount !== '' ? openBlocked : plan.maxPrincipal < 1e-6 ? planLoop(1, leverage, terms).error : null;

  // An open loop: posted pMUSD and MUSD debt, also when built by hand (the unwind authorises LeverageManager first).
  const postedShares = collateral ? (position?.collateral.find((c) => c.id === collateral.id)?.balance ?? 0n) : 0n;
  const musdDebt = musd ? (position?.debts.find((d) => d.marketId === musd.id)?.amount ?? 0n) : 0n;
  const hasLoop = postedShares > 0n && musdDebt > 0n;
  const loopCollateral = musd ? pTokenUnits(musd, postedShares) : 0;
  const loopDebt = musd ? units(musdDebt, musd.decimals) : 0;
  const otherDebt = position?.debts.some((d) => d.marketId !== musd?.id && d.amount > 0n) ?? false;
  const otherCollateral = position?.collateral.some((c) => c.id !== collateral?.id && c.balance > 0n) ?? false;
  const pMusdRow = valued?.collateral.find((c) => c.collateral.id === collateral?.id);
  const musdRow = valued?.debts.find((d) => d.market.id === musd?.id);
  // The rest of the account matters only if it holds or owes anything else; valuing its debt needs prices (null: not loaded).
  const rest: UnwindTerms['rest'] | null =
    !otherDebt && !otherCollateral
      ? undefined
      : otherDebt && !valued
        ? null
        : {
            collateral: otherCollateral,
            debtUsd: otherDebt && valued ? valued.debtUsd - (musdRow?.valueUsd ?? 0) : 0,
            // The pMUSD's share of the limit: only while it is enabled and priced (VaultManager's conservative mode).
            borrowLimitUsd: valued
              ? valued.borrowLimitUsd - (collateral?.enabled && pMusdRow?.priced ? (pMusdRow.valueUsd * collateral.ltvBps) / 10_000 : 0)
              : 0,
            debtPriced: valued ? valued.debts.every((d) => d.market.id === musd?.id || d.amount === 0n || d.priced) : true,
          };
  const unwind =
    hasLoop && musd && rest !== null
      ? planUnwind({
          debt: loopDebt,
          collateral: loopCollateral,
          cash: units(musd.cash, musd.decimals),
          rest,
          musdPrice: musdPrice ?? 0,
          ltvBps: collateral?.enabled ? collateral.ltvBps : 0,
          slippageBps: UNWIND_SLIPPAGE_BPS,
        })
      : null;

  const open = async () => {
    if (!address || !hub || !musd || !protocol || !canOpen || principalWei === null) return;
    const ctx = { account: address, hub, protocol, position: position ?? null };
    const result = await run(`${leverage}× loop`, loopSteps(ctx, musd, principalWei, leverage, position?.isLeverageOperator ?? false));
    if (result.ok) setLastLoop(result.receipts[result.receipts.length - 1].transactionHash);
  };

  const unwindLoop = async () => {
    if (!address || !hub || !protocol || !musd || !unwind || unwind.error) return;
    const shares = unwind.withdrawAll ? maxUint256 : sharesFor(musd, floorUnits(unwind.withdrawn, musd.decimals));
    const args = { shares, minOut: floorUnits(unwind.minOut, musd.decimals), needsPrices: unwind.needsPrices };
    await run('Unwind loop', unwindSteps({ account: address, hub, protocol, position: position ?? null }, args, position?.isLeverageOperator ?? false));
  };

  const trace = [
    { n: '01', title: 'Flash borrow MUSD from MezodotPool', amount: tokenAmount(plan.flashAmount, 'MUSD') },
    { n: '02', title: 'Supply principal + flash into pMUSD', amount: tokenAmount(plan.gross, 'MUSD') },
    { n: '03', title: `Post pMUSD, borrow flash + ${FLASH_FEE} fee`, amount: tokenAmount(plan.debt, 'MUSD') },
    { n: '04', title: 'Repay flash loan (fee to reserves)', amount: 'Same transaction' },
  ];
  // The scenario on its own (no pool or account): what the loop contract does with it.
  const scenario = planLoop(SCENARIO.principal, SCENARIO.leverage, { ltvBps: terms.ltvBps, ltBps: terms.ltBps });
  const scenarioAmount = roundedInput(Math.min(SCENARIO.principal, fundable(SCENARIO.leverage)));
  const scenarioFits = scenarioAmount === String(SCENARIO.principal);

  // Waiting on (or failing) the hub read: say which, instead of a form of zeros.
  if (!protocol) {
    return (
      <section className="panel loop-config-panel">
        <PanelTitle label="Configure your position" meta="MUSD → pMUSD loop" />
        <HubPending what="the MUSD pool" />
      </section>
    );
  }
  if (!musd || !collateral) {
    return (
      <p className="inline-error" role="status">
        The loop needs the MUSD market and pMUSD collateral, and this hub deployment does not list both.
      </p>
    );
  }

  return (
    <>
      <div className="loop-layout">
        <section className="panel loop-config-panel">
          <PanelTitle label="Configure your position" meta="MUSD → pMUSD loop" />
          <div className="form-section">
            <label className="field-label" htmlFor="loop-amount">
              INITIAL EQUITY{' '}
              <span>
                Wallet · {wallet !== undefined ? fmt(units(wallet, musd.decimals), 2) : '—'} MUSD
                {terms.pool ? ` · pool funds ≤ ${fmt(maxLoopPrincipal(leverage, terms), 2)} at ${leverage}×` : ''}
              </span>
            </label>
            <AmountInput
              id="loop-amount"
              large
              value={amount}
              onChange={setTyped}
              unit="MUSD"
              onMax={() => maxWei !== null && setTyped(toInput(maxWei, musd.decimals))}
            />
          </div>
          <div className="form-section">
            <div className="field-label">
              TARGET LEVERAGE{' '}
              <span>
                {leverage.toFixed(2)}× · max {(plan.principal > 0 ? plan.leverageLimit : plan.maxLeverage).toFixed(2)}×
                {after ? ' for your account' : ` at ${collateral.ltvBps / 100}% LTV`}
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
                min="1.25"
                max="4"
                step="0.25"
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
                  <Zap size={15} /> Open {leverage}× loop <ArrowRight size={15} />
                </>
              )}
            </button>
          </ConnectGate>
          {shownBlock && (
            <p className="inline-error" role="alert">
              {shownBlock}
            </p>
          )}
          {!position?.isLeverageOperator && (
            <div className="small-disclosure">
              <Shield size={14} /> First time: one extra transaction authorises LeverageManager as your VaultManager operator.
            </div>
          )}
        </section>

        <div className="loop-side">
          <section className="panel loop-projection">
            <div className="projection-head">
              <span className="overline">POSITION PREVIEW</span>
              <span className="projection-tag">{plan.utilization !== null ? 'RATES AFTER THE LOOP' : 'CURRENT RATES'}</span>
            </div>
            <div className="projection-value">
              <div>
                <small>GROSS POSITION</small>
                <strong>
                  {fmt(plan.gross, 2)} <small>MUSD</small>
                </strong>
              </div>
              <div className="projection-multiplier">{leverage.toFixed(2)}×</div>
            </div>
            <div className="projection-bars">
              <div>
                <span>
                  Your equity <b>{tokenAmount(plan.principal, 'MUSD')}</b>
                </span>
                <i>
                  <span style={{ width: `${100 / leverage}%` }} />
                </i>
              </div>
              <div>
                <span>
                  Debt (incl. fee) <b>{tokenAmount(plan.debt, 'MUSD')}</b>
                </span>
                <i>
                  <span style={{ width: `${Math.min(100, plan.ltv * 100)}%` }} />
                </i>
              </div>
            </div>
            <div className="projection-metrics">
              <div>
                <span>Supply APY</span>
                <b className="positive-text">{fmtApy(plan.supplyApy)}</b>
              </div>
              <div>
                <span>Borrow APY</span>
                <b>{fmtApy(plan.borrowApy)}</b>
              </div>
              <div>
                <span>Net APY on equity</span>
                <b className={plan.netApy >= 0 ? 'positive-text' : 'tone-danger'}>{fmtApy(plan.netApy)}</b>
              </div>
              <div>
                <span>Plain supply, no loop</span>
                <b className="positive-text">{fmtApy(plan.plainSupplyApy)}</b>
              </div>
              <div>
                <span>Utilization after</span>
                <b>{plan.utilization === null ? '—' : pct(plan.utilization)}</b>
              </div>
              <div>
                <span>Flash fee, once</span>
                <b>
                  {tokenAmount(plan.fee, 'MUSD')} <small>{pct(plan.feeCost, 2)} of equity</small>
                </b>
              </div>
            </div>
            <p className={`loop-verdict ${plan.vsPlainSupply >= 0 ? 'is-better' : 'is-worse'}`}>
              {plan.vsPlainSupply >= 0
                ? `The loop earns ${fmtApy(plan.vsPlainSupply)} a year more than plain supply at the rates it leaves the pool at, after a one-off ${tokenAmount(plan.fee, 'MUSD')} flash fee to the pool's reserves.`
                : `The loop earns ${fmtApy(-plan.vsPlainSupply)} a year less than simply supplying: once it is open each borrowed MUSD costs ${fmtApy(plan.borrowApy)} and earns back ${fmtApy(plan.supplyApy)}, and the ${tokenAmount(plan.fee, 'MUSD')} flash fee to the pool's reserves comes on top. Loop only for incentives paid on supplied MUSD.`}
            </p>
            <div className="projection-foot">
              <TriangleAlert size={14} />
              <span>
                Same-asset loop: no price liquidation risk, but its own borrowing raises the pool's utilization, and supply APY stays below borrow APY by
                construction (suppliers earn the borrow rate × utilization × (1 − the {pct(reserveFactor, 0)} reserve factor)), so carry is negative without
                external incentives.
              </span>
            </div>
          </section>

          <section className="panel trace-panel">
            <PanelTitle label="Atomic execution trace" meta="LeverageManager.loop" />
            <div className="trace-list">
              {trace.map((item) => (
                <div className={`trace-item ${lastLoop ? 'trace-item--active' : ''}`} key={item.n}>
                  <span>{lastLoop ? <Check size={11} /> : item.n}</span>
                  <b>{item.title}</b>
                  <small>{item.amount}</small>
                </div>
              ))}
            </div>
            <div className="trace-summary">
              <span>{after ? 'ACCOUNT LTV / HEALTH AFTER' : 'LOOP LTV / HEALTH'}</span>
              <b className={`tone-${healthStatus(after?.healthFactor ?? plan.healthFactor).tone}`}>
                {pct(after?.ltv ?? plan.ltv)} · {fmtHealth(after?.healthFactor ?? plan.healthFactor)}
              </b>
              <span>LIQUIDATION BUFFER</span>
              <b>
                {after ? 'collateral' : 'pMUSD'} −{(plan.liquidationBuffer * 100).toFixed(1)}%
              </b>
            </div>
          </section>

          {hasLoop && (
            <section className="panel open-loop-panel">
              <PanelTitle label="Open pMUSD position" meta="Counts toward account health" />
              <div className="risk-math">
                <span>
                  pMUSD collateral <b>{tokenAmount(loopCollateral, 'MUSD')}</b>
                </span>
                <span>
                  MUSD debt <b>{tokenAmount(loopDebt, 'MUSD')}</b>
                </span>
                <span>
                  Equity <b className={loopCollateral >= loopDebt ? 'positive-text' : 'tone-danger'}>{tokenAmount(loopCollateral - loopDebt, 'MUSD')}</b>
                </span>
                <span>
                  Account health <b>{valued ? fmtHealth(valued.healthFactor) : '…'}</b>
                </span>
              </div>
              {unwind && !unwind.error && <p className="muted-note">{unwindSummary(unwind)}</p>}
              {unwind?.error && (
                <p className="inline-error" role="alert">
                  {unwind.error}
                </p>
              )}
              {unwind?.error && unwind.debtLeft > 0 && (
                <button className="button button--outline button--wide" onClick={() => openModal({ type: 'repay', marketId: musd.id })}>
                  Repay MUSD from your wallet <ArrowRight size={14} />
                </button>
              )}
              <button className="button button--light button--wide" onClick={unwindLoop} disabled={!unwind || unwind.error !== null || Boolean(busy)}>
                <Undo2 size={14} />{' '}
                {busy ??
                  (!unwind
                    ? 'Loading prices…'
                    : unwind.debtLeft > 0
                      ? `Repay ${tokenAmount(unwind.netted, 'MUSD')} with your pMUSD`
                      : unwind.withdrawn <= 0
                        ? `Unwind: repay ${tokenAmount(unwind.netted, 'MUSD')} with pMUSD`
                        : `Unwind: repay ${tokenAmount(unwind.netted, 'MUSD')} with pMUSD, withdraw ${unwind.withdrawAll ? 'the rest' : tokenAmount(unwind.withdrawn, 'MUSD')}`)}
              </button>
              <p className="muted-note">
                No flash loan and no fee: the debt is netted against your pMUSD inside the pool, so the unwind works at any utilization
                {unwind?.needsPrices ? '' : ' and needs no fresh price'}.
                {!position?.isLeverageOperator && ' First time: one extra transaction authorises LeverageManager as your VaultManager operator.'}
              </p>
            </section>
          )}
        </div>
      </div>

      <div className="loop-example">
        <Sparkles size={16} />
        <div>
          <b>
            PRD flow C: {fmt(SCENARIO.principal)} MUSD at {SCENARIO.leverage}×
          </b>
          <p>
            Flash borrow {fmt(scenario.flashAmount)} MUSD, supply {fmt(scenario.gross)}, borrow {fmt(scenario.debt, 1)} (incl. the {FLASH_FEE} fee) and repay
            the flash loan in the same transaction — LTV {pct(scenario.ltv)}, health {fmtHealth(scenario.healthFactor)}.
            {!scenarioFits &&
              terms.pool &&
              ` The pool's idle cash and caps fund ${scenarioAmount ? `at most ${scenarioAmount} MUSD` : 'no loop'} at ${SCENARIO.leverage}× right now.`}
          </p>
        </div>
        <button
          className="text-link"
          disabled={scenarioAmount === ''}
          onClick={() => {
            setLeverage(SCENARIO.leverage);
            setTyped(scenarioAmount);
          }}
        >
          {scenarioFits ? 'Load scenario' : `Load ${SCENARIO.leverage}× at ${scenarioAmount || '—'} MUSD`} <ArrowRight size={13} />
        </button>
      </div>
    </>
  );
}
