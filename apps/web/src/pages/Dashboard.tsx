import { ArrowRight, ArrowUpRight, Clock3, GitBranch, Layers3, Radio, RefreshCw, Wallet, Waves, Zap } from 'lucide-react';
import { useAccount } from 'wagmi';
import { BPS, FLASH_FEE_BPS, perSecondToApy } from '@mezodot/sdk';
import { ChainLogo, ChainLogoStack, TokenLogo } from '../components/Logos';
import { LoopDiagram, prdLoopPlan } from '../components/LoopDiagram';
import { HubPending } from '../components/StatusBanners';
import { InfoBar, NotDeployed, PageTitle, PanelTitle, StatCard, SummaryStrip } from '../components/ui';
import { HUB, HUB_DEPLOYED, SPOKES, spokeByWormholeChain } from '../chain/env';
import { loopVolumeUsd, useAgent, useHubStatus, useLoopStats, usePrices, useProtocol } from '../data/hooks';
import { compactUsd, fmt, fmtApy, money, pct, timeAgo, units } from '../lib/format';
import { collateralTotals, protocolTotals } from '../lib/tvl';
import { useUi } from '../state/UiContext';

type Stats = { crossChainBorrowRatio: number | null; borrowers: number };

/** The protocol at a glance. The connected wallet's own position and history are on Portfolio. */
export function Dashboard() {
  const { go } = useUi();
  const { isConnected } = useAccount();
  const protocol = useProtocol().data;
  const prices = usePrices().data;
  const loops = useLoopStats().data;
  const stats = useAgent<Stats>('/stats').data;
  const hub = useHubStatus();

  // TVL net of borrows (idle pool cash, hub BTC, spoke collateral); supply and borrows are shown beside it.
  const totals = protocol && prices ? protocolTotals(protocol, prices.prices) : null;
  const collateral = protocol && prices ? collateralTotals(protocol, prices.prices) : [];
  const demoLoop = prdLoopPlan(protocol?.collaterals);
  // "Live" only while the hub reads succeed: not before the first one, nor once they fail (values then are older).
  const live = protocol !== undefined && hub.error === null;

  return (
    <>
      <PageTitle
        eyebrow="PROTOCOL OVERVIEW"
        title="Capital, in motion."
        subtitle="An omnichain money market for MUSD and MEZO: ERC-4626 yield, cross-chain collateral via Wormhole, and 1-click loops on the Mezo Hub."
        right={
          <>
            {isConnected && (
              <button className="button button--outline" onClick={() => go('portfolio')}>
                <Wallet size={15} /> Your portfolio
              </button>
            )}
            <button className="button button--dark" onClick={() => go('loop')}>
              <Zap size={15} /> Open loop desk <ArrowRight size={14} />
            </button>
          </>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            {live && <span className="live-dot" />} {HUB.label} <i>/</i>{' '}
            {protocol ? `Block ${fmt(Number(protocol.blockNumber))}${hub.stale ? ' · stale' : ''}` : hub.error ? 'unreachable' : 'connecting…'}
          </>
        }
        time={
          prices
            ? `Oracle prices ${prices.publishTime > 0 ? timeAgo(prices.publishTime * 1000) : 'unavailable'}`
            : hub.error
              ? 'Oracle unreachable'
              : 'Loading prices'
        }
        icon={Clock3}
      />

      {!HUB_DEPLOYED && <NotDeployed />}

      <div className="stats-grid">
        <StatCard
          label="Total value locked"
          value={totals ? compactUsd(totals.tvl) : '—'}
          icon={Layers3}
          foot={totals ? `Supplied ${compactUsd(totals.supplied)} · borrowed ${compactUsd(totals.borrowed)}` : 'Idle pool cash + BTC + spoke collateral'}
        />
        <StatCard
          label="Looping volume"
          value={loops ? compactUsd(loopVolumeUsd(loops, prices?.prices)) : '—'}
          icon={RefreshCw}
          foot={
            loops
              ? `${loops.musdLoops} MUSD loop${loops.musdLoops === 1 ? '' : 's'} · ${loops.btcPositions} BTC position${loops.btcPositions === 1 ? '' : 's'}`
              : 'LeverageManager + SwapLeverageManager events'
          }
          accent
        />
        <StatCard label="Keeper agents" value={protocol ? String(protocol.keeperCount) : '—'} icon={Radio} foot="Unique addresses on KeeperGateway" />
        <StatCard
          label="Cross-chain borrow"
          value={stats?.crossChainBorrowRatio != null ? pct(stats.crossChainBorrowRatio) : '—'}
          icon={GitBranch}
          foot={stats ? `Debt backed by spoke collateral · ${stats.borrowers} borrowers` : 'Needs the Mezodot agent'}
        />
      </div>

      {protocol && (
        <div className="revenue-strip" aria-label="Protocol revenue">
          <span className="revenue-title">PROTOCOL REVENUE</span>
          <span>
            Reserves{' '}
            <b>
              {/* Adaptive: early reserves are cents or less, and "$0.00" would read as no revenue at all. */}
              {money(protocol.markets.reduce((sum, m) => sum + units(m.totalReserves, m.decimals) * (prices?.prices[m.symbol as 'MUSD' | 'MEZO'] ?? 0), 0))}
            </b>
          </span>
          {protocol.markets.map((m) => (
            <span key={m.id}>
              {m.symbol} reserve factor <b>{pct(Number(m.reserveFactor) / 1e18, 0)}</b>
            </span>
          ))}
          <span>
            Flash-loan fee <b>{pct(FLASH_FEE_BPS / BPS, 2)}</b>
          </span>
          <span>
            Liquidation fee <b>{pct(protocol.liquidationFeeBps / 10_000, 0)} of the bonus</b>
          </span>
        </div>
      )}

      <div className="feature-grid">
        <article className="feature-card feature-card--loop">
          <div className="feature-copy">
            <span className="overline">
              <Zap size={13} /> LEVERAGE ENGINE
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
          <div className="loop-visual">
            <LoopDiagram plan={demoLoop} />
          </div>
          <div className="feature-card-foot">
            <span>
              <i className="small-dot" /> Example: 1,000 MUSD × 3
            </span>
            <span>
              pMUSD / MUSD <ArrowUpRight size={13} />
            </span>
          </div>
        </article>

        <article className="feature-card feature-card--bridge">
          <div className="bridge-topline">
            <span className="overline">
              <Waves size={13} /> SPOKE GATEWAY
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
              <ChainLogoStack networks={SPOKES.map((s) => s.name)} />
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
              <ChainLogo network={HUB.name} />
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
          </div>
        </article>
      </div>

      <div className="dashboard-tables">
        <section className="panel market-panel">
          <PanelTitle
            label="Markets"
            meta={live ? 'Live from MezodotPool' : 'From MezodotPool'}
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
                    <tr
                      key={m.id}
                      onClick={() => go('markets')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          go('markets');
                        }
                      }}
                      tabIndex={0}
                      role="link"
                      aria-label={`${m.symbol} market details`}
                      className="clickable-row"
                    >
                      <td>
                        <div className="asset-cell">
                          <TokenLogo symbol={m.symbol} />
                          <span>
                            <b>{m.symbol}</b>
                            <small>{m.receiptSymbol}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <b className="apy-value">{fmtApy(perSecondToApy(m.supplyRatePerSecond))}</b>
                      </td>
                      <td>{fmtApy(perSecondToApy(m.borrowRatePerSecond))}</td>
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

        <section className="panel market-panel">
          <PanelTitle
            label="Collateral"
            meta="Accepted on the hub and on spokes · posted by every account"
            action={
              <button className="text-link" onClick={() => go('borrow')}>
                Borrow against it <ArrowRight size={13} />
              </button>
            }
          />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ASSET</th>
                  <th>HELD ON</th>
                  <th>MAX LTV</th>
                  <th>LIQUIDATION</th>
                  <th>BONUS</th>
                  <th>POSTED</th>
                </tr>
              </thead>
              <tbody>
                {collateral.map(({ collateral: c, valueUsd }) => {
                  const spoke = c.isRemote ? spokeByWormholeChain(c.chainId) : undefined;
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className="asset-cell">
                          <TokenLogo symbol={c.symbol} network={spoke?.name} />
                          <span>
                            <b>{c.symbol}</b>
                            {!c.enabled && <small>Not accepted now</small>}
                          </span>
                        </div>
                      </td>
                      <td>{c.isRemote ? (spoke?.label ?? `Spoke chain ${c.chainId}`) : 'Mezo Hub'}</td>
                      <td>{c.ltvBps / 100}%</td>
                      <td>{c.ltBps / 100}%</td>
                      <td>{c.bonusBps / 100}%</td>
                      <td>{compactUsd(valueUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!protocol && <HubPending what="collateral" />}
        </section>
      </div>

      <InfoBar title="Unaudited testnet protocol." action="How it works" onAction={() => go('architecture')}>
        Smart contracts on {HUB.label} and spoke testnets. Use test funds only.
      </InfoBar>
    </>
  );
}
