import { Activity as ActivityIcon, BarChart3, Code2, Copy, Radio, Shield, TriangleAlert } from 'lucide-react';
import { AddressLink, InfoBar, NotDeployed, PageTitle, PanelTitle, SummaryStrip } from '../components/ui';
import { AGENT_URL, HUB, HUB_DEPLOYED } from '../chain/env';
import { useAgent, useProtocol } from '../data/hooks';
import { fmtHealth, money, pct, timeAgo } from '../lib/format';
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
type Health = { ok: boolean; modules: string[]; keeper: string | null; liquidatorLastRun: number | null };
type Evaluation = { account: string; healthFactor: number; debtUsd: number; plan: { profitUsd: number } | null };

const TOOLS = [
  ['get_markets', 'Pools, APYs, exchange rates, collateral params'],
  ['get_position', 'Cross-chain position valued with fresh Pyth prices'],
  ['get_risk_report', 'Volatility, VaR, LTV advice, walk-forward + DSR'],
  ['simulate_loop', 'Preview a 1-click loop'],
  ['simulate_borrow', 'Health factor after a borrow'],
  ['list_liquidatable', 'Accounts below HF 1 with liquidation plan'],
  ['list_pending_messages', 'Wormhole messages awaiting delivery'],
  ['trigger_liquidation', 'KeeperGateway.triggerLiquidation (dry-run default)'],
  ['relay_message', 'Deliver a VAA (dry-run default)'],
] as const;

export function Agents() {
  const { go, showToast } = useUi();
  const protocol = useProtocol().data;
  const health = useAgent<Health>('/health', 15_000).data;
  const report = useAgent<RiskReport>('/risk', 60_000).data;
  const watch = useAgent<Evaluation[]>('/liquidatable', 15_000).data ?? [];
  const mcpUrl = `${AGENT_URL}/mcp`;

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
        time={health ? `Agent online · ${health.modules.join(', ')}` : 'Agent offline'}
        icon={Radio}
      />
      {!HUB_DEPLOYED && <NotDeployed />}

      <div className="agent-status-band">
        <div className="agent-status-symbol">
          <Radio size={21} />
        </div>
        <div>
          <span className="overline">KEEPER NETWORK</span>
          <h2>{protocol ? `${protocol.keeperCount} keeper${protocol.keeperCount === 1n ? '' : 's'} on KeeperGateway` : 'Reading KeeperGateway…'}</h2>
          <p>
            Anyone can liquidate unhealthy positions (earning the liquidation bonus) or deliver Wormhole messages.{' '}
            {HUB.deployment && <AddressLink network={HUB} address={HUB.deployment.contracts.keeperGateway} />}
          </p>
        </div>
        <span className="monitor-pill">
          <i /> {health ? (health.keeper ? 'AGENT KEEPER ACTIVE' : 'AGENT READ-ONLY') : 'AGENT OFFLINE'}
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
              <PanelTitle label="Liquidation watchlist" meta="HF < 1.2, fresh prices" />
              <div className="endpoint-list">
                {watch.length === 0 && <p className="muted-note">No accounts near liquidation.</p>}
                {watch.slice(0, 6).map((e) => (
                  <div key={e.account}>
                    <span className="method-dot" />
                    <code>{e.account.slice(0, 10)}…</code>
                    <small>
                      HF {fmtHealth(e.healthFactor)} · debt {money(e.debtUsd)}
                    </small>
                    <span className="endpoint-state">{e.plan ? `+${money(e.plan.profitUsd, 2)}` : 'WATCH'}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      ) : (
        <div className="panel empty-state empty-state--panel">
          <BarChart3 size={23} />
          <b>Risk report unavailable</b>
          <span>
            Start the agent (<code>pnpm --filter @mezodot/agent start</code>) — it serves the report at <code>{AGENT_URL}/risk</code>.
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
          Write tools dry-run unless the agent runs with MCP_ALLOW_WRITE=true. Local stdio: pnpm --filter @mezodot/agent mcp.
        </p>
      </section>

      <InfoBar title="Quantitative metrics are research tools, not investment advice." action="Architecture" onAction={() => go('architecture')}>
        DSR (Bailey & López de Prado) discounts the best backtest for the six leverage levels tried.
      </InfoBar>
    </>
  );
}
