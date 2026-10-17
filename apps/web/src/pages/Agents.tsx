import { Activity as ActivityIcon, BarChart3, Code2, Copy, Crosshair, Radio, RefreshCw, Shield, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { DisclaimerBar, PageTitle, PanelTitle, Sparkline, SummaryStrip } from '../components/ui';
import { AGENTS, RISK_METRICS } from '../data/mock';
import { agentDryRun } from '../lib/engine';
import { useApp } from '../state/AppContext';

const pad2 = (n: number) => String(n).padStart(2, '0');

export function Agents() {
  const { go, run, showToast } = useApp();
  const [dryRun, setDryRun] = useState(false);

  const copyEndpoint = () => {
    // Clipboard is unavailable on insecure origins (e.g. LAN http); fall back to showing the value.
    if (!navigator.clipboard) return showToast(`Demo endpoint: ${AGENTS.endpoint}`);
    navigator.clipboard
      .writeText(AGENTS.endpoint)
      .then(() => showToast('Demo endpoint copied'))
      .catch(() => showToast(`Demo endpoint: ${AGENTS.endpoint}`));
  };

  const dry = (kind: 'Liquidation' | 'Rebalance') => {
    if (run((s) => agentDryRun(s, kind))) setDryRun(true);
  };

  return (
    <>
      <PageTitle
        eyebrow="INTELLIGENCE / 05"
        title="Risk, with receipts."
        subtitle="A transparent view into the quantitative signals and keeper flows designed to support autonomous protocol operations."
        right={
          <button className="button button--outline" onClick={copyEndpoint}>
            <Copy size={14} /> Copy demo endpoint
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            MCP / KEEPER GATEWAY <i>/</i> LOCAL DEMO TELEMETRY
          </>
        }
        time="No agent connected"
        icon={Radio}
      />

      <div className="agent-status-band">
        <div className="agent-status-symbol">
          <Radio size={21} />
        </div>
        <div>
          <span className="overline">KEEPER GATEWAY STATUS</span>
          <h2>{dryRun ? 'Dry-run completed.' : 'Monitoring the model.'}</h2>
          <p>KeeperGateway endpoints are shown for product design context. There is no live automation behind this preview.</p>
        </div>
        <span className="monitor-pill">
          <i /> {AGENTS.keeperStatus.toUpperCase()} · DEMO
        </span>
      </div>

      <div className="risk-metrics-grid">
        <article className="risk-metric-card">
          <div className="metric-card-head">
            <span>Deflated Sharpe Ratio</span>
            <Shield size={16} />
          </div>
          <strong>{RISK_METRICS.dsr.toFixed(2)}</strong>
          <div className="meter-track">
            <i style={{ width: `${RISK_METRICS.dsr * 100}%` }} />
          </div>
          <small>DSR &gt; {RISK_METRICS.dsrThreshold.toFixed(2)} threshold · simulated</small>
        </article>
        <article className="risk-metric-card">
          <div className="metric-card-head">
            <span>Walk-forward Sharpe</span>
            <ActivityIcon size={16} />
          </div>
          <strong>{RISK_METRICS.walkForwardSharpe.toFixed(2)}</strong>
          <div className="metric-chart">
            <Sparkline values={RISK_METRICS.walkForwardSeries} />
          </div>
          <small>Out-of-sample · {RISK_METRICS.walkForwardWindows} rolling windows</small>
        </article>
        <article className="risk-metric-card">
          <div className="metric-card-head">
            <span>30-day volatility</span>
            <BarChart3 size={16} />
          </div>
          <strong>
            {RISK_METRICS.volatility30d.toFixed(2)}
            <small>%</small>
          </strong>
          <div className="metric-scale">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <small>MUSD pool · annualized proxy</small>
        </article>
        <article className="risk-metric-card">
          <div className="metric-card-head">
            <span>Max drawdown</span>
            <TriangleAlert size={16} />
          </div>
          <strong>
            {RISK_METRICS.maxDrawdown.toFixed(1)}
            <small>%</small>
          </strong>
          <div className="drawdown-line">
            <span />
          </div>
          <small>Backtest window · 90 days</small>
        </article>
      </div>

      <div className="agent-lower-grid">
        <section className="panel agent-activity-panel">
          <PanelTitle label="Keeper activity" meta="Last 24h · sample data" />
          <div className="keeper-counts">
            <div>
              <span className="keeper-icon keeper-purple">
                <ShieldAlert size={15} />
              </span>
              <span>
                <b>Liquidations monitored</b>
                <small>Risk threshold checks</small>
              </span>
              <strong>{pad2(AGENTS.liquidations24h)}</strong>
            </div>
            <div>
              <span className="keeper-icon keeper-green">
                <RefreshCw size={15} />
              </span>
              <span>
                <b>Spoke rebalances</b>
                <small>Liquidity routing proposals</small>
              </span>
              <strong>{pad2(AGENTS.rebalances24h)}</strong>
            </div>
            <div>
              <span className="keeper-icon keeper-amber">
                <Crosshair size={15} />
              </span>
              <span>
                <b>Risk alerts</b>
                <small>Model-generated flags</small>
              </span>
              <strong>{pad2(AGENTS.riskAlerts24h)}</strong>
            </div>
          </div>
          <div className="agent-actions">
            <button className="button button--outline" onClick={() => dry('Liquidation')}>
              <ShieldAlert size={14} /> Dry-run liquidation
            </button>
            <button className="button button--light" onClick={() => dry('Rebalance')}>
              <RefreshCw size={14} /> Dry-run rebalance
            </button>
          </div>
        </section>
        <section className="panel endpoint-panel">
          <PanelTitle label="MCP endpoint surface" meta="Concept · not deployed" />
          <div className="endpoint-url">
            <span>
              <Code2 size={14} />
            </span>
            <code>{AGENTS.endpoint}</code>
            <button onClick={copyEndpoint} aria-label="Copy demo endpoint">
              <Copy size={14} />
            </button>
          </div>
          <div className="endpoint-list">
            {AGENTS.methods.map(({ method, contract }) => (
              <div key={method}>
                <span className="method-dot" />
                <code>{method}()</code>
                <small>{contract}</small>
                <span className="endpoint-state">SPEC</span>
              </div>
            ))}
          </div>
          <p className="endpoint-disclaimer">Methods are architectural references only. This preview exposes no callable keeper API.</p>
        </section>
      </div>

      <DisclaimerBar title="Quantitative metrics are illustrative, not investment advice." action="Agent architecture" onAction={() => go('architecture')}>
        DSR, walk-forward analysis, volatility, and drawdown are static examples—not a live oracle or validated strategy.
      </DisclaimerBar>
    </>
  );
}
