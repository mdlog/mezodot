import { ArrowRight, ArrowUpRight, Clock3, GitBranch, Layers3, Radio, RefreshCw, Waves, Zap } from 'lucide-react';
import { ActivityRow, DisclaimerBar, PageTitle, PanelTitle, StatCard, SummaryStrip } from '../components/ui';
import { MARKETS, PRICES, PROTOCOL, marketOf } from '../data/mock';
import { marketStats, protocolKpis } from '../lib/engine';
import { compactUsd, fmt, fmtHealth, money, pct } from '../lib/format';
import { healthStatus } from '../lib/protocol';
import { useApp } from '../state/AppContext';
import { HealthBar } from './shared';

export function Dashboard() {
  const { state, summary, go, setSelectedActivity } = useApp();
  const { account, rates } = state;
  const kpis = protocolKpis();
  const musd = marketStats('MUSD');
  const status = healthStatus(summary.healthFactor);
  const postedChains = summary.remoteByChain.filter((c) => c.usd > 0);

  return (
    <>
      <PageTitle
        eyebrow="PROTOCOL OVERVIEW"
        title="Capital, in motion."
        subtitle="A market dashboard for productive MUSD and MEZO across the Mezo Hub and connected Spokes."
        right={
          <button className="button button--dark" onClick={() => go('loop')}>
            <Zap size={15} /> Open loop desk <ArrowRight size={14} />
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            <span className="live-dot" /> {PROTOCOL.network} <i>/</i> {PROTOCOL.snapshot}
          </>
        }
        time={state.elapsedDays > 0 ? `+${state.elapsedDays} simulated days` : 'Demo snapshot'}
        icon={Clock3}
      />

      <div className="stats-grid">
        <StatCard
          label="Total value locked"
          value={compactUsd(kpis.tvl)}
          change={`${PROTOCOL.tvlDailyChange.toFixed(2)}%`}
          icon={Layers3}
          foot="MUSD + MEZO pools + Spoke collateral"
        />
        <StatCard
          label="Looping volume"
          value={compactUsd(PROTOCOL.loopVolume)}
          change={`${PROTOCOL.loopVolumeChange.toFixed(2)}%`}
          icon={RefreshCw}
          foot="Lifetime · simulated"
          accent
        />
        <StatCard label="Keeper agents" value={String(PROTOCOL.activeAgents)} icon={Radio} foot="Demo network participants" />
        <StatCard
          label="Cross-chain borrow"
          value={pct(kpis.crossChainRatio)}
          change={`${PROTOCOL.crossChainChange.toFixed(2)}%`}
          icon={GitBranch}
          foot="MUSD borrow backed by Spoke collateral"
        />
      </div>

      <div className="feature-grid">
        <article className="feature-card feature-card--loop">
          <div className="feature-copy">
            <span className="overline">
              <Zap size={13} /> LEVERAGE ENGINE <b>·</b> 01
            </span>
            <h2>
              One position.
              <br />
              <em>More surface area.</em>
            </h2>
            <p>Turn a single MUSD deposit into a leveraged yield position. Simulate the flash-loan loop before you commit.</p>
            <button className="button button--dark" onClick={() => go('loop')}>
              Configure a loop <ArrowRight size={14} />
            </button>
          </div>
          <div className="loop-visual" aria-label="Simulation: 1,000 MUSD at 3 times exposure">
            <div className="loop-ring loop-ring--outer">
              <div className="loop-ring loop-ring--inner">
                <div className="loop-core">
                  <span>3×</span>
                  <small>EXPOSURE</small>
                </div>
              </div>
            </div>
            <div className="loop-node loop-node--a">
              $1,000<small>equity</small>
            </div>
            <div className="loop-node loop-node--b">
              $3,000<small>position</small>
            </div>
            <div className="loop-orbit-label">
              FLASH
              <br />
              ROUTE
            </div>
            <span className="loop-visual-mark">SIM / 03</span>
          </div>
          <div className="feature-card-foot">
            <span>
              <i className="small-dot" /> Illustrative 3× position
            </span>
            <span>
              pMUSD / MUSD <ArrowUpRight size={13} />
            </span>
          </div>
        </article>

        <article className="feature-card feature-card--bridge">
          <div className="bridge-topline">
            <span className="overline">
              <Waves size={13} /> SPOKE GATEWAY <b>·</b> 02
            </span>
            <span className="route-id">ROUTE / ARB—MEZO</span>
          </div>
          <h2>
            Keep your collateral
            <br />
            where it <em>belongs.</em>
          </h2>
          <p>Post wETH on Arbitrum. Borrow MUSD at the Mezo Hub. No principal bridge in this simulated flow.</p>
          <div className="bridge-map">
            <div className="map-chain">
              <span className="chain-disc chain-disc--arb">A</span>
              <span>
                <b>Arbitrum</b>
                <small>External collateral</small>
              </span>
            </div>
            <div className="map-route">
              <div className="route-dash" />
              <span>
                <Waves size={13} /> WORMHOLE MESSAGE
              </span>
              <div className="route-dash" />
            </div>
            <div className="map-chain">
              <span className="chain-disc chain-disc--mezo">M</span>
              <span>
                <b>Mezo Hub</b>
                <small>MUSD borrowing</small>
              </span>
            </div>
          </div>
          <button className="button button--outline" onClick={() => go('crosschain')}>
            Add collateral <ArrowRight size={14} />
          </button>
          <div className="feature-card-foot">
            <span>
              <span className="live-dot live-dot--muted" /> Remote collateral stays on source chain
            </span>
            <span>FLOW / 02</span>
          </div>
        </article>
      </div>

      <div className="dashboard-lower">
        <section className="panel market-panel">
          <PanelTitle
            label="Markets at a glance"
            meta="Supply / borrow"
            action={
              <button className="text-link" onClick={() => go('markets')}>
                All markets <ArrowRight size={13} />
              </button>
            }
          />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ASSET</th>
                  <th>SUPPLY APY</th>
                  <th>BORROW APY</th>
                  <th>UTILIZATION</th>
                  <th>TVL</th>
                </tr>
              </thead>
              <tbody>
                {MARKETS.map((market) => {
                  const stats = marketStats(market.symbol);
                  return (
                    <tr key={market.symbol} onClick={() => go('markets')} className="clickable-row">
                      <td>
                        <div className="asset-cell">
                          <span className="asset-icon" style={{ background: market.color }}>
                            {market.icon}
                          </span>
                          <span>
                            <b>{market.symbol}</b>
                            <small>{market.name}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <b className="apy-value">{stats.totalSupplyApy.toFixed(2)}%</b>
                        <small className="table-subline">incl. {market.rewardApr.toFixed(1)}% rewards</small>
                      </td>
                      <td>{market.borrowApy.toFixed(2)}%</td>
                      <td>
                        <div className="util-cell">
                          <span className="mini-progress">
                            <i style={{ width: pct(stats.utilization) }} />
                          </span>
                          <span>{pct(stats.utilization, 0)}</span>
                        </div>
                      </td>
                      <td>{compactUsd(stats.suppliedUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-caption">
            <span>
              <i className="tiny-square" /> Utilization rate
            </span>
            <span>
              All metrics simulated <ArrowUpRight size={12} />
            </span>
          </div>
        </section>

        <section className="panel position-panel">
          <PanelTitle label="Your position" meta={`Demo account · ${PROTOCOL.demoAddress}`} />
          <div className="position-value">
            <div>
              <span>NET ACCOUNT VALUE</span>
              <strong>{money(summary.netValue)}</strong>
            </div>
            <span className="value-chip">Hub + Spoke collateral</span>
          </div>
          <div className="position-list">
            <div>
              <span className="position-token token-purple">p</span>
              <span>
                <b>pMUSD supplied</b>
                <small>
                  {fmt(account.earnShares.pMUSD, 2)} pMUSD · <span className="positive-text">{musd.totalSupplyApy.toFixed(2)}% APY</span>
                </small>
              </span>
              <strong>{money(summary.earn.MUSD)}</strong>
            </div>
            {account.earnShares.pMEZO > 0 && (
              <div>
                <span className="position-token token-amber">p</span>
                <span>
                  <b>pMEZO supplied</b>
                  <small>
                    {fmt(account.earnShares.pMEZO, 2)} pMEZO · {fmt(summary.earn.MEZO, 2)} MEZO
                  </small>
                </span>
                <strong>{money(summary.earn.MEZO * PRICES.MEZO)}</strong>
              </div>
            )}
            {account.loop.shares > 0 && (
              <div>
                <span className="position-token token-purple">{fmt(summary.loopCollateral / Math.max(summary.loopEquity, 1), 1)}×</span>
                <span>
                  <b>Looped pMUSD position</b>
                  <small>
                    {money(summary.loopCollateral)} gross · {money(account.loop.debt)} loop debt
                  </small>
                </span>
                <strong>{money(summary.loopEquity)}</strong>
              </div>
            )}
            {postedChains.map((c) => (
              <div key={c.chain.id}>
                <span className="position-token token-blue">{c.chain.short}</span>
                <span>
                  <b>{c.chain.name} collateral</b>
                  <small>{[c.wETH > 0 && `${fmt(c.wETH, 2)} wETH`, c.USDC > 0 && `${fmt(c.USDC, 0)} USDC`].filter(Boolean).join(' + ')}</small>
                </span>
                <strong>{money(c.usd)}</strong>
              </div>
            ))}
            <div>
              <span className="position-token token-amber">↓</span>
              <span>
                <b>MUSD borrowed</b>
                <small>{marketOf('MUSD').borrowApy.toFixed(2)}% borrow APY · Hub debt</small>
              </span>
              <strong className="debt-value">−{money(account.debtMUSD)}</strong>
            </div>
          </div>
          <div className="health-row">
            <div>
              <span>HEALTH FACTOR</span>
              <b className={`tone-${status.tone}`}>{fmtHealth(summary.healthFactor)}</b>
            </div>
            <HealthBar hf={summary.healthFactor} />
            <span className={`health-status tone-${status.tone}`}>{status.label}</span>
          </div>
          <small className="position-rate-note">pMUSD rate {rates.pMUSD.toFixed(4)} MUSD</small>
        </section>
      </div>

      <section className="activity-preview panel">
        <PanelTitle
          label="Recent protocol activity"
          meta="Newest first · simulated"
          action={
            <button className="text-link" onClick={() => go('activity')}>
              Open activity <ArrowRight size={13} />
            </button>
          }
        />
        <div className="activity-rows">
          {state.activities.slice(0, 3).map((item) => (
            <ActivityRow key={item.id} item={item} onClick={() => setSelectedActivity(item)} />
          ))}
        </div>
      </section>

      <DisclaimerBar title="Simulation environment." action="How it works" onAction={() => go('architecture')}>
        Figures are illustrative demo data. No wallet is connected and no transaction is sent to a blockchain.
      </DisclaimerBar>
    </>
  );
}
