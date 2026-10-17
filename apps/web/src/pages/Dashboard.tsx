import { ArrowRight, ArrowUpRight, Clock3, GitBranch, Layers3, Radio, RefreshCw, Waves, Zap } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, perSecondToAnnual } from '@mezodot/sdk';
import { EventIcon, InfoBar, NotDeployed, PageTitle, PanelTitle, StatCard, SummaryStrip, TxLink } from '../components/ui';
import { HUB, HUB_DEPLOYED, SPOKES } from '../chain/env';
import { useActivity } from '../data/activity';
import { computeTvl, useAgent, useLoopStats, usePrices, useProtocol, useValuedPosition } from '../data/hooks';
import { compactUsd, fmt, fmtApy, fmtHealth, money, pct, timeAgo, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import { HealthBar } from './shared';

type Stats = { crossChainBorrowRatio: number | null; borrowers: number };

export function Dashboard() {
  const { go } = useUi();
  const { isConnected } = useAccount();
  const protocol = useProtocol().data;
  const prices = usePrices().data;
  const loops = useLoopStats().data;
  const stats = useAgent<Stats>('/stats').data;
  const { valued } = useValuedPosition();
  const activity = useActivity().data ?? [];

  const tvl = protocol && prices ? computeTvl(protocol, prices.prices) : null;
  const status = valued ? healthStatus(valued.healthFactor) : null;

  return (
    <>
      <PageTitle
        eyebrow="PROTOCOL OVERVIEW"
        title="Capital, in motion."
        subtitle="An omnichain money market for MUSD and MEZO: ERC-4626 yield, cross-chain collateral via Wormhole, and 1-click loops on the Mezo Hub."
        right={
          <button className="button button--dark" onClick={() => go('loop')}>
            <Zap size={15} /> Open loop desk <ArrowRight size={14} />
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            <span className="live-dot" /> {HUB.label} <i>/</i> {protocol ? `Block ${fmt(Number(protocol.blockNumber))}` : 'connecting…'}
          </>
        }
        time={prices ? `Pyth prices ${timeAgo(prices.publishTime * 1000)}` : 'Loading prices'}
        icon={Clock3}
      />

      {!HUB_DEPLOYED && <NotDeployed />}

      <div className="stats-grid">
        <StatCard label="Total value locked" value={tvl === null ? '—' : compactUsd(tvl)} icon={Layers3} foot="Hub pools + collateral on spokes" />
        <StatCard label="Looping volume" value={loops ? compactUsd(units(loops.volume, 18)) : '—'} icon={RefreshCw} foot={loops ? `${loops.loops} loops via LeverageManager` : 'LeverageManager events'} accent />
        <StatCard label="Keeper agents" value={protocol ? String(protocol.keeperCount) : '—'} icon={Radio} foot="Unique addresses on KeeperGateway" />
        <StatCard
          label="Cross-chain borrow"
          value={stats?.crossChainBorrowRatio != null ? pct(stats.crossChainBorrowRatio) : '—'}
          icon={GitBranch}
          foot={stats ? `Debt backed by spoke collateral · ${stats.borrowers} borrowers` : 'Needs the Mezodot agent'}
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
            <p>Turn a single MUSD deposit into a leveraged pMUSD position with an atomic flash-loan loop — one transaction instead of six.</p>
            <button className="button button--dark" onClick={() => go('loop')}>
              Configure a loop <ArrowRight size={14} />
            </button>
          </div>
          <div className="loop-visual" aria-label="1,000 MUSD at 3 times exposure">
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
          </div>
          <div className="feature-card-foot">
            <span>
              <i className="small-dot" /> PRD flow C: 1,000 MUSD × 3
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
            <span className="route-id">{SPOKES.map((s) => s.label).join(' · ')}</span>
          </div>
          <h2>
            Keep your collateral
            <br />
            where it <em>belongs.</em>
          </h2>
          <p>Lock WETH or USDC on a spoke chain, borrow MUSD on Mezo. Only a guardian-signed Wormhole message crosses — never your principal.</p>
          <div className="bridge-map">
            <div className="map-chain">
              <span className="chain-disc chain-disc--arb">{SPOKES[0]?.label[0] ?? 'S'}</span>
              <span>
                <b>{SPOKES.map((s) => s.label.split(' ')[0]).join(' / ')}</b>
                <small>External collateral</small>
              </span>
            </div>
            <div className="map-route">
              <div className="route-dash" />
              <span>
                <Waves size={13} /> WORMHOLE VAA
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
              <span className="live-dot live-dot--muted" /> Principal never leaves the source chain
            </span>
            <span>FLOW / B</span>
          </div>
        </article>
      </div>

      <div className="dashboard-lower">
        <section className="panel market-panel">
          <PanelTitle
            label="Markets"
            meta="Live from MezodotPool"
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
                  <th>SUPPLIED</th>
                </tr>
              </thead>
              <tbody>
                {(protocol?.markets ?? []).map((m) => {
                  const util = m.totalAssets > 0n ? Number(m.totalBorrows) / Number(m.totalAssets) : 0;
                  const price = prices?.prices[m.symbol as 'MUSD' | 'MEZO'] ?? 0;
                  return (
                    <tr key={m.id} onClick={() => go('markets')} className="clickable-row">
                      <td>
                        <div className="asset-cell">
                          <span className="asset-icon" style={{ background: m.symbol === 'MUSD' ? '#5b52ce' : '#b97b48' }}>
                            M
                          </span>
                          <span>
                            <b>{m.symbol}</b>
                            <small>{m.receiptSymbol}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <b className="apy-value">{fmtApy(perSecondToAnnual(m.supplyRatePerSecond))}</b>
                      </td>
                      <td>{fmtApy(perSecondToAnnual(m.borrowRatePerSecond))}</td>
                      <td>
                        <div className="util-cell">
                          <span className="mini-progress">
                            <i style={{ width: pct(util) }} />
                          </span>
                          <span>{pct(util, 0)}</span>
                        </div>
                      </td>
                      <td>{compactUsd(units(m.totalAssets, m.decimals) * price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel position-panel">
          <PanelTitle label="Your position" meta={isConnected ? 'Valued with fresh Pyth prices' : 'Connect a wallet'} />
          {valued ? (
            <>
              <div className="position-value">
                <div>
                  <span>NET COLLATERAL − DEBT</span>
                  <strong>{money(valued.collateralUsd - valued.debtUsd)}</strong>
                </div>
                <span className="value-chip">Borrow limit {money(valued.borrowLimitUsd)}</span>
              </div>
              <div className="position-list">
                {valued.collateral
                  .filter((c) => c.balance > 0n)
                  .map((c) => (
                    <div key={c.collateral.id}>
                      <span className={`position-token ${c.collateral.isRemote ? 'token-blue' : 'token-purple'}`}>{c.collateral.isRemote ? '↗' : 'p'}</span>
                      <span>
                        <b>{c.collateral.symbol} collateral</b>
                        <small>
                          {fmt(c.units, 4)} · {c.collateral.isRemote ? `spoke chain ${c.collateral.chainId}` : 'Mezo Hub'}
                        </small>
                      </span>
                      <strong>{money(c.valueUsd)}</strong>
                    </div>
                  ))}
                {valued.debts
                  .filter((d) => d.amount > 0n)
                  .map((d) => (
                    <div key={d.market.id}>
                      <span className="position-token token-amber">↓</span>
                      <span>
                        <b>{d.market.symbol} borrowed</b>
                        <small>{fmtApy(perSecondToAnnual(d.market.borrowRatePerSecond))} borrow APY</small>
                      </span>
                      <strong className="debt-value">−{money(d.valueUsd)}</strong>
                    </div>
                  ))}
                {valued.collateralUsd === 0 && valued.debtUsd === 0 && <p className="muted-note">No collateral or debt yet.</p>}
              </div>
              <div className="health-row">
                <div>
                  <span>HEALTH FACTOR</span>
                  <b className={`tone-${status!.tone}`}>{fmtHealth(valued.healthFactor)}</b>
                </div>
                <HealthBar hf={valued.healthFactor} />
                <span className={`health-status tone-${status!.tone}`}>{status!.label}</span>
              </div>
            </>
          ) : (
            <p className="muted-note">{isConnected ? 'Loading position…' : 'Connect a wallet to see your collateral, debt and health factor.'}</p>
          )}
        </section>
      </div>

      <section className="activity-preview panel">
        <PanelTitle
          label="Your recent activity"
          meta="On-chain events"
          action={
            <button className="text-link" onClick={() => go('activity')}>
              Open activity <ArrowRight size={13} />
            </button>
          }
        />
        <div className="activity-rows">
          {activity.slice(0, 3).map((item) => (
            <div className="activity-row" key={item.id}>
              <EventIcon kind={item.kind} />
              <span className="activity-row-main">
                <b>
                  {item.kind} {fmt(units(item.amount, item.decimals), 4)} {item.asset}
                </b>
                <small>{item.detail}</small>
              </span>
              <TxLink network={item.network === HUB.name ? HUB : SPOKES.find((s) => s.name === item.network)!} hash={item.txHash} />
              <span className="activity-row-time">{item.timestamp ? timeAgo(item.timestamp) : ''}</span>
            </div>
          ))}
          {activity.length === 0 && <p className="muted-note">{isConnected ? 'No activity yet.' : 'Connect a wallet to see your activity.'}</p>}
        </div>
      </section>

      <InfoBar title="Unaudited testnet protocol." action="How it works" onAction={() => go('architecture')}>
        Smart contracts on {HUB.label} and spoke testnets. Use test funds only.
      </InfoBar>
    </>
  );
}
