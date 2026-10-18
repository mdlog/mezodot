import { useState } from 'react';
import { ArrowRight, Check, Shield, Sparkles, TriangleAlert, Undo2, Zap } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, perSecondToAnnual, planLoop } from '@mezodot/sdk';
import { AmountInput, ConnectGate, NotDeployed, PageTitle, PanelTitle, SummaryStrip } from '../components/ui';
import { HUB, HUB_DEPLOYED } from '../chain/env';
import { loopSteps, unwindSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { useHubClient, useValuedPosition, useWalletBalances } from '../data/hooks';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { fmt, fmtApy, fmtHealth, money, pct, units } from '../lib/format';
import { BtcLeverage } from './BtcLeverage';

const LEVERAGE_OPTIONS = [1.5, 2, 2.5, 3, 3.5, 4];

type Mode = 'btc' | 'musd';

export function Loop() {
  const [mode, setMode] = useState<Mode>(HUB.deployment?.contracts.swapLeverageManager ? 'btc' : 'musd');
  return (
    <>
      <PageTitle
        eyebrow="CAPITAL / 04"
        title="Leverage desk."
        subtitle="One-transaction positions on the Mezo Hub, built on the MUSD pool's flash loan: a leveraged BTC long through the Tigris DEX, or a pMUSD supply loop. VaultManager enforces the LTV, so an unsafe position simply reverts."
        right={
          <span className="security-pill">
            <Shield size={14} /> ATOMIC FLASH-LOAN ROUTE
          </span>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            {mode === 'btc' ? 'SWAPLEVERAGEMANAGER · TIGRIS MUSD/BTC' : 'LEVERAGEMANAGER · pMUSD LOOP'} <i>/</i> ERC-3156 FLASH LOAN · 0.09% FEE
          </>
        }
        time="One transaction"
        icon={Zap}
      />
      {!HUB_DEPLOYED && <NotDeployed />}
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
  );
}

function MusdLoop() {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const { valued, protocol, position, prices } = useValuedPosition();
  const balances = useWalletBalances().data;
  const [amount, setAmount] = useState('1000');
  const [leverage, setLeverage] = useState(3);
  const [lastLoop, setLastLoop] = useState<string | null>(null);

  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const collateral = protocol?.collaterals.find((c) => c.symbol === 'pMUSD');
  const supplyApy = musd ? perSecondToAnnual(musd.supplyRatePerSecond) : 0;
  const borrowApy = musd ? perSecondToAnnual(musd.borrowRatePerSecond) : 0;
  const plan = planLoop(Number(amount) || 0, leverage, { ltvBps: collateral?.ltvBps ?? 8000, ltBps: collateral?.ltBps ?? 8500, supplyApy, borrowApy });
  const wallet = balances?.hub.tokens.MUSD ?? 0n;
  const liquidity = musd ? units(musd.cash, musd.decimals) : 0;
  const principalWei = musd ? parseInput(amount, musd.decimals) : null;
  const overBalance = principalWei !== null && principalWei > wallet;
  const overLiquidity = plan.flashAmount > liquidity;

  const loopCollateral = valued?.collateral.find((c) => c.collateral.symbol === 'pMUSD');
  const loopDebt = valued?.debts.find((d) => d.market.symbol === 'MUSD');
  const hasLoop = (loopCollateral?.balance ?? 0n) > 0n && (loopDebt?.amount ?? 0n) > 0n;
  const equity = (loopCollateral?.valueUsd ?? 0) - (loopDebt?.valueUsd ?? 0);

  const open = async () => {
    if (!address || !hub || !musd || !protocol || plan.error || principalWei === null) return;
    const principal = principalWei;
    const ctx = { account: address, hub, protocol, position: position ?? null };
    const result = await run(`${leverage}× loop`, loopSteps(ctx, musd, principal, leverage, position?.isLeverageOperator ?? false));
    if (result.ok) setLastLoop(result.receipts[result.receipts.length - 1].transactionHash);
  };

  const unwind = async () => {
    if (!address || !hub || !protocol) return;
    // Equity is in USD; the contract pays out MUSD. Accept up to 2% below the estimate (fees + interest).
    const musdPrice = prices?.MUSD ?? 1;
    const minOut = floorUnits((Math.max(0, equity) / musdPrice) * 0.98, musd?.decimals ?? 18);
    await run('Unwind loop', unwindSteps({ account: address, hub, protocol, position: position ?? null }, minOut));
  };

  const trace = [
    { n: '01', title: 'Flash borrow MUSD from MezodotPool', amount: money(plan.flashAmount) },
    { n: '02', title: 'Supply principal + flash into pMUSD', amount: money(plan.gross) },
    { n: '03', title: 'Post pMUSD, borrow flash + fee', amount: money(plan.debt, 2) },
    { n: '04', title: 'Repay flash loan', amount: 'Same transaction' },
  ];

  return (
    <>
      <div className="loop-layout">
        <section className="panel loop-config-panel">
          <PanelTitle label="Configure your position" meta="MUSD → pMUSD loop" />
          <div className="form-section">
            <label className="field-label" htmlFor="loop-amount">
              INITIAL EQUITY <span>Wallet · {musd ? fmt(units(wallet, musd.decimals), 2) : '—'} MUSD</span>
            </label>
            <AmountInput
              id="loop-amount"
              large
              value={amount}
              onChange={setAmount}
              unit="MUSD"
              onMax={() => musd && setAmount(toInput(wallet, musd.decimals))}
            />
          </div>
          <div className="form-section">
            <div className="field-label">
              TARGET LEVERAGE{' '}
              <span>
                {leverage.toFixed(2)}× · max {plan.maxLeverage.toFixed(2)}× at {(collateral?.ltvBps ?? 8000) / 100}% LTV
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
          <ConnectGate connected={isConnected}>
            <button
              className="button button--dark button--wide"
              onClick={open}
              disabled={Boolean(plan.error) || principalWei === null || overBalance || overLiquidity || Boolean(busy)}
            >
              {busy ?? (
                <>
                  <Zap size={15} /> Open {leverage}× loop <ArrowRight size={15} />
                </>
              )}
            </button>
          </ConnectGate>
          {(plan.error || overBalance || overLiquidity) && (
            <p className="inline-error" role="alert">
              {plan.error ?? (overBalance ? 'Amount exceeds your MUSD balance' : 'Not enough MUSD liquidity for the flash loan')}
            </p>
          )}
          <div className="small-disclosure">
            <Shield size={14} /> First time: one extra transaction authorises LeverageManager as your VaultManager operator.
          </div>
        </section>

        <div className="loop-side">
          <section className="panel loop-projection">
            <div className="projection-head">
              <span className="overline">POSITION PREVIEW</span>
              <span className="projection-tag">LIVE RATES</span>
            </div>
            <div className="projection-value">
              <div>
                <small>GROSS POSITION</small>
                <strong>{money(plan.gross)}</strong>
              </div>
              <div className="projection-multiplier">{leverage.toFixed(2)}×</div>
            </div>
            <div className="projection-bars">
              <div>
                <span>
                  Your equity <b>{money(plan.principal)}</b>
                </span>
                <i>
                  <span style={{ width: `${100 / leverage}%` }} />
                </i>
              </div>
              <div>
                <span>
                  Debt (incl. fee) <b>{money(plan.debt, 2)}</b>
                </span>
                <i>
                  <span style={{ width: `${Math.min(100, plan.ltv * 100)}%` }} />
                </i>
              </div>
            </div>
            <div className="projection-metrics">
              <div>
                <span>Supply APY</span>
                <b className="positive-text">{fmtApy(supplyApy)}</b>
              </div>
              <div>
                <span>Borrow APY</span>
                <b>{fmtApy(borrowApy)}</b>
              </div>
              <div>
                <span>Net APY on equity</span>
                <b className={plan.netApy >= 0 ? 'positive-text' : 'tone-danger'}>{fmtApy(plan.netApy)}</b>
              </div>
              <div>
                <span>Plain supply, no loop</span>
                <b className="positive-text">{fmtApy(supplyApy)}</b>
              </div>
            </div>
            <p className={`loop-verdict ${plan.netApy >= supplyApy ? 'is-better' : 'is-worse'}`}>
              {plan.netApy >= supplyApy
                ? `The loop earns ${fmtApy(plan.netApy - supplyApy)} more than plain supply at current rates.`
                : `The loop earns ${fmtApy(supplyApy - plan.netApy)} less than simply supplying: each borrowed MUSD costs ${fmtApy(borrowApy)} and earns back only ${fmtApy(supplyApy)}. Loop only for incentives paid on supplied MUSD.`}
            </p>
            <div className="projection-foot">
              <TriangleAlert size={14} />
              <span>
                Same-asset loop: no price liquidation risk, but supply APY is always below borrow APY by construction, so carry is negative without external
                incentives. Use the risk report before looping volatile collateral.
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
              <span>LOOP LTV / HEALTH</span>
              <b className={`tone-${healthStatus(plan.healthFactor).tone}`}>
                {pct(plan.ltv)} · {fmtHealth(plan.healthFactor)}
              </b>
              <span>LIQUIDATION BUFFER</span>
              <b>pMUSD −{(plan.liquidationBuffer * 100).toFixed(1)}%</b>
            </div>
          </section>

          {hasLoop && (
            <section className="panel open-loop-panel">
              <PanelTitle label="Open pMUSD position" meta="Counts toward account health" />
              <div className="risk-math">
                <span>
                  pMUSD collateral <b>{money(loopCollateral!.valueUsd, 2)}</b>
                </span>
                <span>
                  MUSD debt <b>{money(loopDebt!.valueUsd, 2)}</b>
                </span>
                <span>
                  Equity <b className="positive-text">{money(equity, 2)}</b>
                </span>
                <span>
                  Account health <b>{fmtHealth(valued!.healthFactor)}</b>
                </span>
              </div>
              <button className="button button--light button--wide" onClick={unwind} disabled={Boolean(busy)}>
                <Undo2 size={14} /> {busy ?? 'Unwind: repay all MUSD debt, withdraw all pMUSD'}
              </button>
              <p className="muted-note">Equity comes back in MUSD; whatever the pool cannot pay out right now comes back as pMUSD, still earning.</p>
            </section>
          )}
        </div>
      </div>

      <div className="loop-example">
        <Sparkles size={16} />
        <div>
          <b>PRD flow C: 1,000 MUSD at 3×</b>
          <p>
            Flash borrow 2,000 MUSD, supply 3,000, borrow 2,001.8 (incl. 0.09% fee) and repay the flash loan in the same transaction — LTV 66.7%, health{' '}
            {fmtHealth((3_000 * (collateral?.ltBps ?? 8500)) / 10_000 / 2_001.8)}.
          </p>
        </div>
        <button
          className="text-link"
          onClick={() => {
            setAmount('1000');
            setLeverage(3);
          }}
        >
          Load scenario <ArrowRight size={13} />
        </button>
      </div>
    </>
  );
}
