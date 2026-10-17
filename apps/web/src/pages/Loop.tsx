import { useState } from 'react';
import { ArrowRight, Check, Shield, Sparkles, TriangleAlert, Undo2, Zap } from 'lucide-react';
import { AmountInput, PageTitle, PanelTitle, SummaryStrip } from '../components/ui';
import { RISK_PARAMS, marketOf } from '../data/mock';
import { closeLoop, marketStats, openLoop, previewLoop } from '../lib/engine';
import { fmtHealth, money, pct } from '../lib/format';
import { healthStatus, maxLeverage } from '../lib/protocol';
import { useApp } from '../state/AppContext';

// Max LTV 70% caps recursive leverage at 1 / (1 − 0.7) ≈ 3.33×, so the selector stops at 3×.
const LEVERAGE_OPTIONS = [1.5, 2, 2.5, 3];
const MAX_LEVERAGE = LEVERAGE_OPTIONS[LEVERAGE_OPTIONS.length - 1];

export function Loop() {
  const { state, summary, run } = useApp();
  const { account } = state;
  const [amount, setAmount] = useState('1000');
  const [leverage, setLeverage] = useState(3);
  const [lastRun, setLastRun] = useState(false);

  const plan = previewLoop(Number(amount) || 0, leverage);
  const stats = marketStats('MUSD');
  const borrowApy = marketOf('MUSD').borrowApy;
  const tone = healthStatus(plan.healthFactor).tone;

  const simulate = () => {
    if (run((s) => openLoop(s, Number(amount) || 0, leverage))) setLastRun(true);
  };

  const trace = [
    { n: '01', title: 'Flash borrow MUSD', amount: money(plan.debt) },
    { n: '02', title: 'Supply into MezodotPool', amount: money(plan.gross) },
    { n: '03', title: 'Borrow against pMUSD', amount: money(plan.debt) },
    { n: '04', title: 'Repay flash liquidity', amount: 'Same block' },
  ];

  return (
    <>
      <PageTitle
        eyebrow="CAPITAL / 04"
        title="Loop desk."
        subtitle="Amplify a yield position with a single simulated flash-loan route—without stitching together six separate steps."
        right={
          <span className="security-pill">
            <Shield size={14} /> ATOMIC ROUTE DESIGN
          </span>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            LEVERAGEMANAGER <i>/</i> FLASH-LOAN SIMULATOR
          </>
        }
        time="Single-action preview"
        icon={Zap}
      />

      <div className="loop-layout">
        <section className="panel loop-config-panel">
          <PanelTitle label="Configure your position" meta="MUSD → pMUSD yield loop" />
          <div className="form-section">
            <label className="field-label" htmlFor="loop-amount">
              INITIAL EQUITY <span>Wallet balance · {money(account.wallet.MUSD, 2)} MUSD</span>
            </label>
            <AmountInput
              id="loop-amount"
              large
              value={amount}
              onChange={setAmount}
              unit="MUSD"
              onMax={() => setAmount(String(Math.floor(account.wallet.MUSD * 100) / 100))}
            />
            <div className="amount-estimate">
              You provide <b>{money(plan.principal)} equity</b>
            </div>
          </div>
          <div className="form-section">
            <div className="field-label">
              TARGET LEVERAGE <span>{leverage.toFixed(2)}×</span>
            </div>
            <div className="leverage-selector">
              {LEVERAGE_OPTIONS.map((value) => (
                <button key={value} className={leverage === value ? 'is-selected' : ''} onClick={() => setLeverage(value)} aria-pressed={leverage === value}>
                  {value}×
                </button>
              ))}
            </div>
            <div className="slider-shell">
              <input
                aria-label="Leverage target"
                type="range"
                min={LEVERAGE_OPTIONS[0]}
                max={MAX_LEVERAGE}
                step="0.25"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
              />
              <div>
                <span>{LEVERAGE_OPTIONS[0]}× · lower risk</span>
                <span>
                  {MAX_LEVERAGE}× · limit {maxLeverage(RISK_PARAMS.maxLtv).toFixed(2)}× at {pct(RISK_PARAMS.maxLtv, 0)} LTV
                </span>
              </div>
            </div>
          </div>
          <div className="loop-route">
            <div>
              <span className="loop-step-num">01</span>
              <span>
                <b>Flash borrow</b>
                <small>{money(plan.debt)} MUSD · same-block simulation</small>
              </span>
            </div>
            <ArrowRight size={14} />
            <div>
              <span className="loop-step-num">02</span>
              <span>
                <b>Supply to pMUSD</b>
                <small>{money(plan.gross)} total collateral</small>
              </span>
            </div>
            <ArrowRight size={14} />
            <div>
              <span className="loop-step-num">03</span>
              <span>
                <b>Borrow & repay</b>
                <small>Atomic route · one transaction</small>
              </span>
            </div>
          </div>
          <button className="button button--dark button--wide" onClick={simulate}>
            <Zap size={15} /> Simulate {leverage}× loop <ArrowRight size={15} />
          </button>
          <div className="small-disclosure">
            <Shield size={14} /> This is a local simulation. No flash loan or contract call is executed.
          </div>
        </section>

        <div className="loop-side">
          <section className="panel loop-projection">
            <div className="projection-head">
              <span className="overline">POSITION PROJECTION</span>
              <span className="projection-tag">MOCK MODEL</span>
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
                  Borrowed <b>{money(plan.debt)}</b>
                </span>
                <i>
                  <span style={{ width: `${(1 - 1 / leverage) * 100}%` }} />
                </i>
              </div>
            </div>
            <div className="projection-metrics">
              <div>
                <span>Supply APY</span>
                <b className="positive-text">{stats.totalSupplyApy.toFixed(2)}%</b>
                <small>
                  {stats.baseSupplyApy.toFixed(2)}% + {marketOf('MUSD').rewardApr.toFixed(2)}% MEZO
                </small>
              </div>
              <div>
                <span>Borrow APY</span>
                <b>{borrowApy.toFixed(2)}%</b>
              </div>
              <div>
                <span>Net modeled APY</span>
                <b className={plan.netApy >= 0 ? 'positive-text' : 'tone-danger'}>{plan.netApy.toFixed(2)}%</b>
                <small>on equity, incl. rewards</small>
              </div>
            </div>
            <div className="projection-foot">
              <TriangleAlert size={14} />
              <span>
                Without MEZO rewards the loop is net-negative: borrow APY ({borrowApy.toFixed(2)}%) exceeds base supply APY ({stats.baseSupplyApy.toFixed(2)}%).
                Estimates use static mock assumptions.
              </span>
            </div>
          </section>

          <section className="panel trace-panel">
            <PanelTitle label="Atomic execution trace" meta="LeverageManager · demo" />
            <div className="trace-list">
              {trace.map((item, index) => (
                <div className={`trace-item ${lastRun || index === 0 ? 'trace-item--active' : ''}`} key={item.n}>
                  <span>{lastRun ? <Check size={11} /> : item.n}</span>
                  <b>{item.title}</b>
                  <small>{item.amount}</small>
                </div>
              ))}
            </div>
            <div className="trace-summary">
              <span>LOOP LTV / HEALTH</span>
              <b className={`tone-${tone}`}>
                {pct(plan.ltv)} · {fmtHealth(plan.healthFactor)}
              </b>
              <span>LIQUIDATION BUFFER</span>
              <b>pMUSD −{plan.liquidationBuffer.toFixed(1)}%</b>
            </div>
            {plan.error && (
              <p className="inline-error" role="alert">
                {plan.error}
              </p>
            )}
          </section>

          {account.loop.shares > 0 && (
            <section className="panel open-loop-panel">
              <PanelTitle label="Open loop position" meta="Counts toward account health" />
              <div className="risk-math">
                <span>
                  Gross pMUSD <b>{money(summary.loopCollateral, 2)}</b>
                </span>
                <span>
                  Loop debt <b>{money(account.loop.debt, 2)}</b>
                </span>
                <span>
                  Equity <b className="positive-text">{money(summary.loopEquity, 2)}</b>
                </span>
                <span>
                  Account health <b>{fmtHealth(summary.healthFactor)}</b>
                </span>
              </div>
              <button className="button button--light button--wide" onClick={() => run(closeLoop)}>
                <Undo2 size={14} /> Unwind loop
              </button>
            </section>
          )}
        </div>
      </div>

      <div className="loop-example">
        <Sparkles size={16} />
        <div>
          <b>Try the PRD scenario: 1,000 MUSD at 3×</b>
          <p>Simulates a 2,000 MUSD flash borrow, a 3,000 MUSD supply position, and a same-block 2,000 MUSD repay — 66.7% LTV, 1.20× health factor.</p>
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
