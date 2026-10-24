import { useState } from 'react';
import { ArrowRight, Coins, Layers3, ShieldCheck, Wallet } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, perSecondToApy, type ProtocolState, type ValuedPosition } from '@mezodot/sdk';
import { TokenLogo } from '../components/Logos';
import { HubPending, QueryError } from '../components/StatusBanners';
import {
  AddressLink,
  ConnectGate,
  EventIcon,
  NotDeployed,
  PageTitle,
  Pagination,
  PanelTitle,
  PriceNotice,
  StatCard,
  SummaryStrip,
  TxLink,
} from '../components/ui';
import { HUB, HUB_DEPLOYED, SPOKES, networkByName, spokeByWormholeChain } from '../chain/env';
import { useActivity } from '../data/activity';
import { useSpokeClaims } from '../data/claims';
import { usePosition, usePrices, useValuedPosition, useWalletBalances } from '../data/hooks';
import { fmt, fmtApy, fmtHealth, money, shortAddress, timeAgo, units } from '../lib/format';
import { paginate } from '../lib/paginate';
import { accountHoldings, type Holdings, type SupplyRow } from '../lib/portfolio';
import { useUi } from '../state/UiContext';
import { PositionHealth } from './shared';

const ACTIVITY_PAGE_SIZE = 5;

/**
 * Everything the connected wallet holds in Mezodot, in one place: what it supplied, the collateral it posted on the hub
 * and on spokes, its debt and health, releases waiting on a spoke, and its recent history. The action pages keep only
 * what their action needs; each section here links to the page that acts on it.
 */
export function Portfolio() {
  const { address, isConnected } = useAccount();
  const { valued, protocol, unpriced, unpricedDebts, relayError } = useValuedPosition();
  const positionQuery = usePosition();
  const prices = usePrices().data;
  const wallet = useWalletBalances();
  const holdings = protocol && valued && prices ? accountHoldings(protocol, valued, wallet.data?.hub.tokens, prices.prices) : null;

  return (
    <>
      <PageTitle
        eyebrow="ACCOUNT"
        title="Everything you hold, in one place."
        subtitle="Supplied pTokens, collateral on the Mezo Hub and spoke chains, debt and health for the connected wallet, valued at the prices VaultManager accepts now."
        right={address && <AddressLink network={HUB} address={address} />}
      />
      <SummaryStrip
        snapshot={
          <>
            ACCOUNT <i>/</i> {address ? shortAddress(address) : 'NO WALLET CONNECTED'}
          </>
        }
        time="Fresh-price valuation"
        icon={Wallet}
      />
      {!HUB_DEPLOYED && <NotDeployed />}
      <ConnectGate connected={isConnected} label="Connect a wallet to see your portfolio">
        {protocol && valued && holdings ? (
          <>
            <Summary valued={valued} holdings={holdings} walletError={wallet.error} blocked={unpricedDebts.length > 0} />
            <PriceNotice unpriced={unpriced} relayError={relayError} unpricedDebts={unpricedDebts} />
            <div className="portfolio-layout">
              <div className="portfolio-main">
                <SuppliedPanel supplies={holdings.supplies} />
                <CollateralPanel protocol={protocol} valued={valued} />
                <BorrowedPanel valued={valued} />
              </div>
              <div className="portfolio-side">
                <PositionHealth valued={valued} />
                {SPOKES.some((s) => s.deployment) && <CrossChainPanel valued={valued} />}
              </div>
            </div>
            {/* Keyed by wallet: another wallet starts on its newest events. */}
            <RecentActivity key={address} />
          </>
        ) : (
          <PositionPending error={positionQuery.error} onRetry={() => void positionQuery.refetch()} />
        )}
      </ConnectGate>
    </>
  );
}

function Summary({ valued, holdings, walletError, blocked }: { valued: ValuedPosition; holdings: Holdings; walletError: unknown; blocked: boolean }) {
  const pools = holdings.supplies.length;
  const hasDebt = Number.isFinite(valued.healthFactor);
  return (
    <div className="stats-grid">
      <StatCard
        label="Net worth"
        value={holdings.netWorthUsd === null ? '—' : money(holdings.netWorthUsd)}
        icon={Wallet}
        foot={
          holdings.netWorthUsd !== null ? 'pTokens + collateral − debt' : walletError ? 'Could not read your wallet balances' : 'Reading your wallet balances…'
        }
        accent
      />
      <StatCard
        label="Supplied"
        value={holdings.suppliedUsd === null ? '—' : money(holdings.suppliedUsd)}
        icon={Coins}
        foot={pools > 0 ? `${pools} pool${pools === 1 ? '' : 's'} · earning the supply rate` : 'Supply MUSD or MEZO to earn'}
      />
      <StatCard
        label="Borrowed"
        value={money(valued.debtUsd)}
        icon={Layers3}
        foot={blocked ? 'Borrowing blocked until prices are fresh' : `Available ${money(valued.availableUsd)}`}
      />
      <StatCard
        label="Health factor"
        value={fmtHealth(valued.healthFactor)}
        icon={ShieldCheck}
        foot={hasDebt ? `${healthStatus(valued.healthFactor).label} · liquidatable below 1.00×` : 'No debt'}
      />
    </div>
  );
}

function SuppliedPanel({ supplies }: { supplies: SupplyRow[] }) {
  const { go, openModal } = useUi();
  return (
    <section className="panel portfolio-panel">
      <PanelTitle
        label="Supplied"
        meta="pTokens, in the asset they redeem for"
        action={
          <button className="text-link" onClick={() => go('markets')}>
            Markets <ArrowRight size={13} />
          </button>
        }
      />
      {supplies.length === 0 ? (
        <p className="muted-note">Nothing supplied yet. Supply MUSD or MEZO on Markets for pTokens that earn the pool's supply rate.</p>
      ) : (
        <div className="table-wrap">
          <table className="portfolio-table">
            <thead>
              <tr>
                <th>ASSET</th>
                <th>IN WALLET</th>
                <th>POSTED</th>
                <th>VALUE</th>
                <th>SUPPLY APY</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {supplies.map(({ market: m, walletUnits, postedUnits, valueUsd }) => (
                <tr key={m.id}>
                  <td>
                    <div className="asset-cell">
                      <TokenLogo symbol={m.symbol} />
                      <span>
                        <b>{m.symbol}</b>
                        <small>as {m.receiptSymbol}</small>
                      </span>
                    </div>
                  </td>
                  <td>{walletUnits === undefined ? '—' : fmt(walletUnits, 4)}</td>
                  <td>{fmt(postedUnits, 4)}</td>
                  <td>{valueUsd === undefined ? '—' : money(valueUsd)}</td>
                  <td className="apy-value">{fmtApy(perSecondToApy(m.supplyRatePerSecond))}</td>
                  <td>
                    <div className="row-actions">
                      <button className="button button--light" onClick={() => openModal({ type: 'supply', marketId: m.id })}>
                        Supply
                      </button>
                      {/* Unknown (unread) is not zero: only an empty wallet disables it. */}
                      <button className="button button--light" onClick={() => openModal({ type: 'withdraw', marketId: m.id })} disabled={walletUnits === 0}>
                        Withdraw
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CollateralPanel({ protocol, valued }: { protocol: ProtocolState; valued: ValuedPosition }) {
  const { go, openModal } = useUi();
  const held = valued.collateral.filter((c) => c.balance > 0n);
  return (
    <section className="panel portfolio-panel">
      <PanelTitle label="Collateral" meta={`${money(valued.collateralUsd)} · borrow limit ${money(valued.borrowLimitUsd)}`} />
      {held.length === 0 ? (
        <>
          <p className="muted-note">No collateral posted yet.</p>
          <div className="borrow-add-links portfolio-links">
            <button className="text-link" onClick={() => go('markets')}>
              Post on Mezo (BTC, pTokens) <ArrowRight size={13} />
            </button>
            <button className="text-link" onClick={() => go('crosschain')}>
              Lock on a spoke (WETH, USDC) <ArrowRight size={13} />
            </button>
          </div>
        </>
      ) : (
        <div className="table-wrap">
          <table className="portfolio-table">
            <thead>
              <tr>
                <th>ASSET</th>
                <th>HELD ON</th>
                <th>AMOUNT</th>
                <th>VALUE</th>
                <th>LTV / LIQ.</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {held.map(({ collateral: c, units: amount, valueUsd }) => {
                const spoke = c.isRemote ? spokeByWormholeChain(c.chainId) : undefined;
                // Posted pTokens count in the asset they redeem for (valuePosition converts them at the exchange rate).
                const unit = c.isShare ? (protocol.markets.find((m) => m.pool.toLowerCase() === c.token.toLowerCase())?.symbol ?? c.symbol) : c.symbol;
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="asset-cell">
                        <TokenLogo symbol={c.symbol} network={spoke?.name} />
                        <span>
                          <b>{c.symbol}</b>
                        </span>
                      </div>
                    </td>
                    <td>{c.isRemote ? (spoke?.label ?? `Spoke chain ${c.chainId}`) : 'Mezo Hub'}</td>
                    <td>
                      {fmt(amount, 4)} {unit}
                    </td>
                    <td>{money(valueUsd)}</td>
                    <td>
                      {c.ltvBps / 100}% / {c.ltBps / 100}%
                    </td>
                    <td>
                      <div className="row-actions">
                        {/* Spoke collateral leaves through VaultManager.withdrawRemote and a Wormhole release: Cross-chain does both. */}
                        {c.isRemote ? (
                          <button className="button button--light" onClick={() => go('crosschain')}>
                            Withdraw on Cross-chain
                          </button>
                        ) : (
                          <button className="button button--light" onClick={() => openModal({ type: 'unpost', collateralId: c.id })}>
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BorrowedPanel({ valued }: { valued: ValuedPosition }) {
  const { go, openModal } = useUi();
  const owed = valued.debts.filter((d) => d.amount > 0n);
  return (
    <section className="panel portfolio-panel">
      <PanelTitle
        label="Borrowed"
        meta="One health factor across every chain"
        action={
          <button className="text-link" onClick={() => go('borrow')}>
            Borrow <ArrowRight size={13} />
          </button>
        }
      />
      {owed.length === 0 ? (
        <p className="muted-note">No debt. Borrow MUSD or MEZO against collateral on the hub or a spoke.</p>
      ) : (
        <div className="table-wrap">
          <table className="portfolio-table">
            <thead>
              <tr>
                <th>ASSET</th>
                <th>DEBT</th>
                <th>VALUE</th>
                <th>BORROW APY</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {owed.map((d) => (
                <tr key={d.market.id}>
                  <td>
                    <div className="asset-cell">
                      <TokenLogo symbol={d.market.symbol} />
                      <span>
                        <b>{d.market.symbol}</b>
                      </span>
                    </div>
                  </td>
                  <td>
                    {fmt(d.units, 2)} {d.market.symbol}
                  </td>
                  <td>{money(d.valueUsd)}</td>
                  <td>{fmtApy(perSecondToApy(d.market.borrowRatePerSecond))}</td>
                  <td>
                    <div className="row-actions">
                      <button className="button button--light" onClick={() => openModal({ type: 'repay', marketId: d.market.id })}>
                        Repay
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Spoke collateral in one line, and releases a spoke gateway holds for the account (claimed on Cross-chain). */
function CrossChainPanel({ valued }: { valued: ValuedPosition }) {
  const { go } = useUi();
  const claims = useSpokeClaims().data?.claims ?? [];
  return (
    <section className="panel portfolio-panel">
      <PanelTitle label="Cross-chain" meta="SpokeGateway · Wormhole" />
      <p className="muted-note">
        {valued.remoteCollateralUsd > 0 ? `${money(valued.remoteCollateralUsd)} locked on spokes and credited on the hub.` : 'Nothing locked on a spoke.'}{' '}
        Messages in transit are tracked on Cross-chain until they are delivered.
      </p>
      {claims.length > 0 && (
        <div className="portfolio-claims">
          <h4>Ready to claim</h4>
          {claims.map((c) => (
            <div className="collateral-detail" key={`${c.spoke.name}-${c.symbol}`}>
              <TokenLogo symbol={c.symbol} network={c.spoke.name} size={23} />
              <span>
                <b>
                  {fmt(units(c.amount, c.decimals), 6)} {c.symbol}
                </b>
                <small>Held by the {c.spoke.label} gateway</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <button className="button button--outline button--wide" onClick={() => go('crosschain')}>
        {claims.length > 0 ? 'Claim on Cross-chain' : 'Lock, withdraw or track on Cross-chain'} <ArrowRight size={14} />
      </button>
    </section>
  );
}

function RecentActivity() {
  const { go } = useUi();
  const activityQuery = useActivity();
  const activity = activityQuery.data?.items ?? [];
  const [page, setPage] = useState(0);
  const shown = paginate(activity, page, ACTIVITY_PAGE_SIZE);
  return (
    <section className="activity-preview panel">
      <PanelTitle
        label="Recent activity"
        meta="On-chain events"
        action={
          <button className="text-link" onClick={() => go('activity')}>
            Full history <ArrowRight size={13} />
          </button>
        }
      />
      <div className="activity-rows">
        {shown.rows.map((item) => (
          <div className="activity-row" key={item.id}>
            <EventIcon kind={item.kind} />
            <span className="activity-row-main">
              <b>
                {item.kind} {fmt(units(item.amount, item.decimals), 4)} {item.asset}
              </b>
              <small>{item.detail}</small>
            </span>
            <TxLink network={networkByName(item.network) ?? HUB} hash={item.txHash} />
            <span className="activity-row-time">{item.timestamp ? timeAgo(item.timestamp) : ''}</span>
          </div>
        ))}
        {activityQuery.isError && <QueryError error={activityQuery.error} what="your on-chain history" onRetry={() => void activityQuery.refetch()} />}
        {activity.length === 0 &&
          !activityQuery.isError &&
          (activityQuery.data ? <p className="muted-note">No activity yet.</p> : <HubPending what="your activity" />)}
      </div>
      <Pagination page={shown} label="Activity" onPage={setPage} />
    </section>
  );
}

/** Why there is nothing to show yet: the position read failing, or the hub (and prices) still loading or failing. */
function PositionPending({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error) return <QueryError error={error} what="your position" onRetry={onRetry} />;
  return <HubPending what="your portfolio" />;
}
