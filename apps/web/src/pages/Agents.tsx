import { Activity as ActivityIcon, BarChart3, Code2, Copy, Radio, Shield, TriangleAlert } from 'lucide-react';
import { BPS } from '@mezodot/sdk';
import { agentState, type AgentState, type AgentStatus } from '../components/Topology';
import { AddressLink, InfoBar, NotDeployed, PageTitle, PanelTitle, SummaryStrip } from '../components/ui';
import { AGENT_URL, HUB, HUB_DEPLOYED } from '../chain/env';
import { useAgent, useHubStatus, useProtocol } from '../data/hooks';
import { compactUsd, fmtHealth, money, pct, timeAgo } from '../lib/format';
import { useUi } from '../state/UiContext';

type AssetRisk = {
  symbol: string;
  collateral: string | null;
  points: number;
  lastPrice: number;
  vol30dAnnual: number;
  vol90dAnnual: number;
  maxDrawdown90d: number;
  var99_1h: number;
  var99_24h: number;
  currentLtv: number | null;
  recommendedLtv: number | null;
  verdict: 'ok' | 'tighten' | 'n/a';
};
type StrategyRisk = {
  collateral: string;
  description: string;
  windows: number;
  oosSharpeAnnual: number;
  deflatedSharpe: number;
  modalLeverage: number;
  robust: boolean;
};
type RiskReport = {
  generatedAt: number;
  dsrThreshold: number;
  assets: AssetRisk[];
  strategies: StrategyRisk[];
  loopCarry: { leverage: number; netApy: number }[];
  notes: string[];
};
/** The keeper's verdict on a planned liquidation (LiquidationAssessment in services/agent/src/liquidator.ts). */
type Assessment = {
  action: 'liquidate' | 'skip';
  /** Seized BTC: sold on Tigris right away, or held until a sale covers the repayment. */
  sale: 'sell' | 'hold' | null;
  /** Profit at the price the keeper can realise (the Tigris sale for BTC), net of gas and fees. */
  netProfitUsd: number;
  reason: string;
};
/** GET /liquidatable: borrowers below HF 1.2; `assessment` once the keeper has priced a liquidation of them. */
export type Evaluation = { account: string; healthFactor: number; debtUsd: number; assessment?: Assessment | null };

/** Signed USD: +$12.34, −$0.40, +$1.2K. */
const signedUsd = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${compactUsd(Math.abs(n))}`;

/**
 * A watchlist row: the profit the keeper can realise once it has assessed the liquidation (after gas, fees and
 * the Tigris sale, not the oracle-valued bonus) and its decision, else whether the account is liquidatable or only
 * close to it. The state column is a few characters wide: the profit goes in the note.
 */
export function watchRow(e: Evaluation): { state: string; note: string | null; reason: string | null } {
  const a = e.assessment;
  if (a) {
    const held = a.action === 'liquidate' && a.sale === 'hold' ? ', seizure held' : '';
    return { state: a.action === 'skip' ? 'SKIP' : 'LIQ', note: `net ${signedUsd(a.netProfitUsd)}${held}`, reason: a.reason };
  }
  if (e.healthFactor < 1) {
    return {
      state: '—',
      note: 'not priced by the keeper',
      reason: 'Liquidatable; the keeper has not priced a liquidation of it (read-only agent, no plan, or the assessment is pending or failed)',
    };
  }
  return { state: 'WATCH', note: null, reason: null };
}

/** The keeper badge: what the agent's own checks say, not only whether it answers. */
export function agentBadge(agent: AgentState, keeper: string | null | undefined): string {
  if (agent.state === 'checking') return 'CHECKING AGENT…';
  if (agent.state === 'offline') return 'AGENT OFFLINE';
  if (agent.state === 'degraded') return 'AGENT DEGRADED';
  return keeper ? 'AGENT KEEPER ACTIVE' : 'AGENT READ-ONLY';
}

const TOOLS = [
  ['get_markets', 'Pools, APYs, exchange rates, reserves, collateral params'],
  ['get_position', 'Cross-chain position at the prices the protocol accepts now'],
  ['get_oracle_health', 'Per-feed sources, age and validity (Pyth push, Supra pull)'],
  ['get_risk_report', 'Volatility, VaR, LTV advice, walk-forward + DSR, loop carry'],
  ['get_revenue', "Reserves, flash fees and the treasury's liquidation fees"],
  ['simulate_loop', 'Preview a 1-click MUSD loop; optional address: the account after it'],
  ['simulate_btc_leverage', 'Preview a BTC long: Tigris flash swap, no flash fee'],
  ['simulate_btc_close', 'Preview a BTC close: Tigris sale, no pool cash needed'],
  ['simulate_borrow', 'Health factor after a borrow'],
  ['list_liquidatable', 'Accounts below HF 1: plan and realisable net profit'],
  ['list_pending_messages', 'Wormhole messages awaiting delivery, flagged when stuck'],
  ['trigger_liquidation', 'Liquidate through KeeperGateway (dry-run default)'],
  ['relay_message', 'Deliver a VAA (dry-run default)'],
] as const;

export function Agents() {
  const { go, showToast } = useUi();
  const protocol = useProtocol().data;
  const hub = useHubStatus();
  // /status, not /health: /health answers 503 while degraded, which a browser cannot tell from an agent that is down.
  const status = useAgent<AgentStatus>('/status', 15_000).data;
  const agent = agentState(status);
  const answering = agent.state === 'ok' || agent.state === 'degraded';
  const report = useAgent<RiskReport>('/risk', 60_000).data;
  const watch = useAgent<Evaluation[]>('/liquidatable', 15_000).data ?? [];
  const mcpUrl = `${AGENT_URL}/mcp`;
  // The critical checks are what make it degraded; name those first.
  const critical = agent.failing.filter((c) => c.severity === 'critical');
  const why = (critical.length > 0 ? critical : agent.failing).map((c) => c.name).join(', ');
  const modules = (status?.modules ?? []).join(', ');
  const agentLine =
    agent.state === 'ok'
      ? `Agent online${modules ? ` · ${modules}` : ''}`
      : agent.state === 'degraded'
        ? `Agent degraded${why ? ` · ${why}` : ''}`
        : agent.state === 'offline'
          ? 'Agent offline'
          : 'Checking the agent…';
  // The liquidator keeps the bonus less the protocol's share of it (ProtocolState.liquidationFeeBps, owner-set).
  const bonusNote = !protocol
    ? 'earning the liquidation bonus, less the protocol share'
    : protocol.liquidationFeeBps > 0
      ? `earning the liquidation bonus, of which ${pct(protocol.liquidationFeeBps / BPS, 0)} goes to the treasury`
      : 'earning the whole liquidation bonus';

  const copy = () => {
    if (!navigator.clipboard) return showToast(mcpUrl);
    navigator.clipboard
      .writeText(mcpUrl)
      .then(() => showToast('MCP endpoint copied'))
      .catch(() => showToast(mcpUrl));
  };

  return (
    <>
      <PageTitle
        eyebrow="INTELLIGENCE / 05"
        title="Risk, with receipts."
        subtitle="Permissionless keepers liquidate and relay through KeeperGateway. The Mezodot agent publishes quantitative risk — volatility, VaR-based LTV advice and Deflated Sharpe walk-forward tests — over HTTP and MCP."
        right={
          <button className="button button--outline" onClick={copy}>
            <Copy size={14} /> Copy MCP endpoint
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            KEEPERGATEWAY <i>/</i> MCP · STREAMABLE HTTP + STDIO
          </>
        }
        time={agentLine}
        icon={Radio}
      />
      {!HUB_DEPLOYED && <NotDeployed />}

      <div className="agent-status-band">
        <div className="agent-status-symbol">
          <Radio size={21} />
        </div>
        <div>
          <span className="overline">KEEPER NETWORK</span>
          <h2>
            {protocol
              ? `${protocol.keeperCount} keeper${protocol.keeperCount === 1n ? '' : 's'} on KeeperGateway`
              : hub.error
                ? 'KeeperGateway unreachable right now'
                : 'Reading KeeperGateway…'}
          </h2>
          <p>
            Anyone can liquidate unhealthy positions ({bonusNote}) or deliver Wormhole messages.{' '}
            {HUB.deployment && <AddressLink network={HUB} address={HUB.deployment.contracts.keeperGateway} />}
          </p>
          {agent.failing.length > 0 && (
            <p className={agent.state === 'degraded' ? 'tone-warn' : undefined}>
              {agent.state === 'degraded' ? 'Failing checks' : 'Warnings'}: {agent.failing.map((c) => c.name).join(', ')}
            </p>
          )}
        </div>
        <span
          className={`monitor-pill${agent.state === 'degraded' ? ' tone-warn' : ''}`}
          title={agent.failing.length > 0 ? agent.failing.map((c) => `${c.name}: ${c.detail}`).join('\n') : undefined}
        >
          <i /> {agentBadge(agent, status?.keeper)}
        </span>
      </div>

      {report ? (
        <>
          <div className="risk-metrics-grid">
            {report.assets.map((a) => (
              <article className="risk-metric-card" key={a.symbol}>
                <div className="metric-card-head">
                  <span>
                    {a.symbol}
                    {a.collateral ? ` · ${a.collateral}` : ''}
                  </span>
                  {a.verdict === 'tighten' ? <TriangleAlert size={16} /> : <Shield size={16} />}
                </div>
                <strong>
                  {pct(a.vol90dAnnual)}
                  <small> vol</small>
                </strong>
                <small>
                  1h VaR99 {pct(a.var99_1h, 2)} · 90d max DD {pct(a.maxDrawdown90d)}
                </small>
                <small className={a.verdict === 'tighten' ? 'tone-warn' : ''}>
                  LTV {a.currentLtv === null ? '—' : pct(a.currentLtv, 0)} vs advised ≤ {a.recommendedLtv === null ? '—' : pct(a.recommendedLtv)} ·{' '}
                  {a.verdict.toUpperCase()}
                </small>
              </article>
            ))}
          </div>

          <div className="agent-lower-grid">
            <section className="panel agent-activity-panel">
              <PanelTitle label="Walk-forward leverage tests" meta={`Deflated Sharpe ≥ ${report.dsrThreshold} = robust`} />
              <div className="keeper-counts">
                {report.strategies.map((s) => (
                  <div key={s.collateral}>
                    <span className={`keeper-icon ${s.robust ? 'keeper-green' : 'keeper-amber'}`}>
                      <ActivityIcon size={15} />
                    </span>
                    <span>
                      <b>
                        {s.collateral} collateral · modal {s.modalLeverage}×
                      </b>
                      <small>
                        OOS Sharpe {s.oosSharpeAnnual.toFixed(2)} · {s.windows} windows · DSR {s.deflatedSharpe.toFixed(3)}
                      </small>
                    </span>
                    <strong className={s.robust ? 'positive-text' : 'tone-warn'}>{s.robust ? 'ROBUST' : 'OVERFIT?'}</strong>
                  </div>
                ))}
              </div>
              <p className="endpoint-disclaimer">
                Hourly prices, 90 days. Updated {timeAgo(report.generatedAt)}. {report.notes.join(' ')}
              </p>
            </section>
            <section className="panel endpoint-panel">
              <PanelTitle label="Liquidation watchlist" meta="HF < 1.2 · profit the keeper can realise, net of costs" />
              <div className="endpoint-list">
                {watch.length === 0 && <p className="muted-note">No accounts near liquidation.</p>}
                {watch.slice(0, 6).map((e) => {
                  const row = watchRow(e);
                  return (
                    <div key={e.account} title={row.reason ?? undefined}>
                      <span className="method-dot" />
                      <code>{e.account.slice(0, 10)}…</code>
                      <small>
                        HF {fmtHealth(e.healthFactor)} · debt {money(e.debtUsd)}
                        {row.note && ` · ${row.note}`}
                      </small>
                      <span className="endpoint-state">{row.state}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </>
      ) : (
        <div className="panel empty-state empty-state--panel">
          <BarChart3 size={23} />
          <b>Risk report unavailable</b>
          <span>
            {agent.state === 'checking'
              ? 'Checking the Mezodot agent…'
              : answering
                ? 'The Mezodot agent is up, but its risk report is not ready yet; it appears here once the agent has built it.'
                : 'The Mezodot agent is not answering right now; the report appears here as soon as it is back.'}{' '}
            Keepers and liquidations on-chain do not depend on this page.
            {import.meta.env.DEV && (
              <>
                {' '}
                Local development: start it with <code>pnpm --filter @mezodot/agent start</code> (serves <code>{AGENT_URL}/risk</code>).
              </>
            )}
          </span>
        </div>
      )}

      <section className="panel endpoint-panel">
        <PanelTitle label="MCP server" meta="For AI agents (Claude, custom keepers)" />
        <div className="endpoint-url">
          <span>
            <Code2 size={14} />
          </span>
          <code>{mcpUrl}</code>
          <button onClick={copy} aria-label="Copy MCP endpoint">
            <Copy size={14} />
          </button>
        </div>
        <div className="endpoint-list">
          {TOOLS.map(([name, desc]) => (
            <div key={name}>
              <span className="method-dot" />
              <code>{name}()</code>
              <small>{desc}</small>
              <span className="endpoint-state">{name.startsWith('trigger') || name.startsWith('relay') ? 'WRITE' : 'READ'}</span>
            </div>
          ))}
        </div>
        <p className="endpoint-disclaimer">
          Write tools dry-run unless the agent runs with MCP_ALLOW_WRITE=true (over HTTP, with MCP_TOKEN too). Local stdio: pnpm --filter @mezodot/agent mcp.
        </p>
      </section>

      <InfoBar title="Quantitative metrics are research tools, not investment advice." action="Architecture" onAction={() => go('architecture')}>
        DSR (Bailey & López de Prado) discounts the best backtest for the six leverage levels tried.
      </InfoBar>
    </>
  );
}
