import { useState } from 'react';
import { ArrowRight, ArrowUpRight, LockKeyhole, Network, Shield, ShieldAlert } from 'lucide-react';
import { AmountInput, PageTitle, PanelTitle, SummaryStrip } from '../components/ui';
import { RISK_PARAMS, marketOf } from '../data/mock';
import { borrow as borrowAction, marketStats } from '../lib/engine';
import { fmt, fmtHealth, money, pct } from '../lib/format';
import { healthFactor, healthStatus, parseAmount } from '../lib/protocol';
import { useApp } from '../state/AppContext';

/** LTV meter spans 0..90% so both the max-borrow and liquidation marks are visible. */
const METER_SPAN = 0.9;

export function Borrow() {
  const { state, summary, go, openAmount, showToast } = useApp();
  const { account } = state;
  const [amount, setAmount] = useState('1000');
  const parsed = parseAmount(amount);
  const status = healthStatus(summary.healthFactor);
  const posted = summary.remoteByChain.filter((c) => c.usd > 0);
  // Live preview of the position after the entered borrow.
  const previewHf = parsed ? healthFactor(summary.collateral, summary.debt + parsed, RISK_PARAMS.liquidationThreshold) : summary.healthFactor;

  const review = () => {
    if (parsed === null) return showToast('Enter a valid MUSD amount to borrow', 'error');
    if (parsed > summary.available) return showToast(`Amount exceeds available capacity (${money(summary.available, 2)})`, 'error');
    // Validate with the engine too (pool liquidity etc.) before opening the confirmation.
    const check = borrowAction(state, parsed);
    if (!check.ok) return showToast(check.error, 'error');
    openAmount('borrow', 'MUSD', String(parsed));
  };

  return (
    <>
      <PageTitle
        eyebrow="CAPITAL / 03"
        title="Borrow against your position."
        subtitle="Use remote collateral to open a MUSD position on the Mezo Hub. Your principal stays on its source chain."
        right={
          <span className="availability-pill">
            <i /> MUSD liquidity available · {money(marketStats('MUSD').liquidity)}
          </span>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            VAULTMANAGER <i>/</i> CROSS-CHAIN LTV STATE
          </>
        }
        time="Risk parameters simulated"
        icon={Shield}
      />

      <div className="borrow-layout">
        <section className="panel borrow-form-panel">
          <PanelTitle label="Borrow MUSD" meta="Mezo Hub · MUSD Pool" />
          <div className="borrow-from">
            <div>
              <span className="field-label">COLLATERAL POSITION</span>
              {posted.length === 0 && <p className="muted-note">No collateral posted yet.</p>}
              {posted.map((c) => (
                <div className="collateral-detail" key={c.chain.id}>
                  <span className="coin-large" style={{ background: c.chain.color }}>
                    {c.chain.short}
                  </span>
                  <span>
                    <b>{[c.wETH > 0 && `${fmt(c.wETH, 2)} wETH`, c.USDC > 0 && `${fmt(c.USDC)} USDC`].filter(Boolean).join(' + ')}</b>
                    <small>
                      {c.chain.name} Spoke · {money(c.usd)}
                    </small>
                  </span>
                </div>
              ))}
              {summary.loopCollateral > 0 && (
                <div className="collateral-detail">
                  <span className="coin-large coin-loop">p</span>
                  <span>
                    <b>{money(summary.loopCollateral)} pMUSD</b>
                    <small>Loop position · Mezo Hub</small>
                  </span>
                </div>
              )}
            </div>
            <button className="text-link" onClick={() => go('crosschain')}>
              Manage collateral <ArrowRight size={13} />
            </button>
          </div>
          <label className="field-label" htmlFor="borrow-amount">
            BORROW AMOUNT <span>Available up to {money(summary.available, 2)}</span>
          </label>
          <AmountInput
            id="borrow-amount"
            large
            value={amount}
            onChange={setAmount}
            unit="MUSD"
            onMax={() => setAmount(String(Math.floor(summary.available * 100) / 100))}
          />
          <div className="amount-estimate">
            Wallet balance <b>{money(account.wallet.MUSD, 2)} MUSD</b>
          </div>
          <div className="borrow-preview">
            <div>
              <span>Borrow APY</span>
              <b>{marketOf('MUSD').borrowApy.toFixed(2)}%</b>
            </div>
            <div>
              <span>Health after borrow</span>
              <b className={`tone-${healthStatus(previewHf).tone}`}>{fmtHealth(previewHf)}</b>
            </div>
            <div>
              <span>wETH liquidation price</span>
              <b>{summary.liquidationPriceWeth === null ? '—' : summary.liquidationPriceWeth === 0 ? 'None' : `${money(summary.liquidationPriceWeth, 2)}`}</b>
            </div>
          </div>
          <div className="borrow-actions">
            <button className="button button--dark button--wide" onClick={review}>
              Review borrow <ArrowRight size={15} />
            </button>
            <button className="button button--light button--wide" onClick={() => openAmount('repay', 'MUSD')} disabled={account.debtMUSD <= 0}>
              Repay debt <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="small-disclosure">
            <LockKeyhole size={14} /> Simulated preview only · no signing or transaction broadcast
          </div>
        </section>

        <div className="borrow-side">
          <section className="panel risk-panel">
            <PanelTitle
              label="Position health"
              meta="VaultManager state"
              action={
                <span className={`health-badge tone-${status.tone}`}>
                  <i /> {status.label}
                </span>
              }
            />
            <div className="health-overview">
              <div className="health-number">
                <span>HEALTH FACTOR</span>
                <strong className={`tone-${status.tone}`}>{fmtHealth(summary.healthFactor)}</strong>
                <em>Liquidation risk increases below 1.00×</em>
              </div>
              <div className="health-gauge">
                <div className="gauge-inner">
                  <b>{pct(summary.ltv)}</b>
                  <small>CURRENT LTV</small>
                </div>
                <div className="gauge-needle" style={{ transform: `rotate(${-125 + Math.min(100, summary.ltv * 100) * 2.5}deg)` }} />
              </div>
            </div>
            <div className="risk-meter">
              <div>
                <span>Current LTV</span>
                <b>{pct(summary.ltv)}</b>
              </div>
              <div className="meter-track meter-track--marked">
                <i style={{ width: `${Math.min(100, (summary.ltv / METER_SPAN) * 100)}%` }} />
                <span className="meter-mark" style={{ left: `${(RISK_PARAMS.maxLtv / METER_SPAN) * 100}%` }} />
                <span className="meter-mark meter-mark--danger" style={{ left: `${(RISK_PARAMS.liquidationThreshold / METER_SPAN) * 100}%` }} />
              </div>
              <div className="meter-labels">
                <span>0%</span>
                <span>{pct(RISK_PARAMS.maxLtv, 0)} max borrow</span>
                <span>{pct(RISK_PARAMS.liquidationThreshold, 0)} liquidation</span>
              </div>
            </div>
            <div className="risk-math">
              <span>
                Collateral value <b>{money(summary.collateral)}</b>
              </span>
              <span>
                Outstanding debt <b>{money(summary.debt)}</b>
              </span>
              <span>
                Available capacity <b className="positive-text">{money(summary.available)}</b>
              </span>
            </div>
          </section>
          <div className="panel vaultmanager-note">
            <span className="note-icon">
              <ShieldAlert size={17} />
            </span>
            <div>
              <b>One risk view, multiple chains.</b>
              <p>
                VaultManager aggregates Spoke collateral and the loop position, enforces LTV limits, and computes one health factor at the Mezo Hub. Figures
                here are local demo values.
              </p>
            </div>
          </div>
          <button className="panel link-panel" onClick={() => go('architecture')}>
            <span className="link-panel-icon">
              <Network size={17} />
            </span>
            <span>
              <b>How hub accounting works</b>
              <small>Explore the cross-chain state model</small>
            </span>
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </>
  );
}
