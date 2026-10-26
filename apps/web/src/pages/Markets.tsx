import { useState } from 'react';
import { ArrowRight, Coins, LayoutGrid, List, LockKeyhole, Plus, TrendingUp } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  BPS,
  FLASH_FEE_BPS,
  perSecondToApy,
  pTokenUnits,
  symbolForPriceKey,
  type CollateralState,
  type MarketState,
  type PositionState,
  type ProtocolState,
  type UsdPrices,
} from '@mezodot/sdk';
import { TokenLogo } from '../components/Logos';
import { HubPending } from '../components/StatusBanners';
import { AddressLink, NotDeployed, PageTitle, SummaryStrip } from '../components/ui';
import { HUB, HUB_DEPLOYED } from '../chain/env';
import { postBlocked, supplyBlocked, useHubFlags, type HubFlags } from '../data/guards';
import { usePrices, useProtocol, useValuedPosition, useWalletBalances, type WalletBalances } from '../data/hooks';
import { toInput } from '../lib/amount';
import { compactUsd, fmt, fmtApy, money, pct, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import './markets.css';

/** A fraction as a percentage with only the decimals it needs: 0.06 → "6%", 0.0925 → "9.25%". */
const percent = (ratio: number): string => `${(ratio * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/**
 * How rates and protocol revenue work, from the live parameters: each pool's InterestRateModel (MarketState.rateModel)
 * and reserve factor (owner-set, up to 30%), the flash-loan fee and the treasury's share of liquidation bonuses.
 */
export function ratesExplainer(protocol: Pick<ProtocolState, 'markets' | 'liquidationFeeBps'>): string {
  // InterestRateModel: borrow APR = base + slope1 at the kink (simple annual rates; the cards above show APYs).
  const curves = protocol.markets.flatMap((m) =>
    m.rateModel ? [`${m.symbol} ${percent(m.rateModel.base + m.rateModel.slope1)} at ${percent(m.rateModel.kink)} utilization`] : [],
  );
  const factors = protocol.markets.map((m) => ({ symbol: m.symbol, value: percent(Number(m.reserveFactor) / 1e18) }));
  const reserveFactor =
    factors.length === 0
      ? 'reserve factor'
      : factors.every((f) => f.value === factors[0].value)
        ? `${factors[0].value} reserve factor`
        : `reserve factor: ${factors.map((f) => `${f.symbol} ${f.value}`).join(', ')}`;
  return [
    `Kinked curve per pool, steep above the kink${curves.length > 0 ? ` (borrow APR at the kink: ${curves.join(', ')})` : ''}.`,
    `Supply rate = borrow rate × utilization × (1 − ${reserveFactor}).`,
    `Flash-loan fees (${percent(FLASH_FEE_BPS / BPS)}) go to reserves, and ${percent(protocol.liquidationFeeBps / BPS)} of each liquidation bonus to the treasury.`,
  ].join(' ');
}

// ---- Layout: the same markets as cards or as a table ----

export type MarketsView = 'grid' | 'list';
const VIEW_KEY = 'mezodot-markets-view';

/** The layout stored in this browser; nothing stored, or anything unrecognised, opens the grid. */
export const parseMarketsView = (raw: string | null): MarketsView => (raw === 'list' ? 'list' : 'grid');

function useMarketsView(): [MarketsView, (view: MarketsView) => void] {
  const [view, setView] = useState<MarketsView>(() => {
    try {
      return parseMarketsView(window.localStorage.getItem(VIEW_KEY));
    } catch {
      return 'grid';
    }
  });
  // Only a layout the visitor picked is stored, so a visitor who never picks follows the default.
  const pick = (next: MarketsView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // storage unavailable: the layout holds for this visit
    }
  };
  return [view, pick];
}

/** One market on the page: a lending pool, or plain collateral held on the hub (BTC). */
export type MarketEntry =
  | {
      kind: 'pool';
      market: MarketState;
      price: number;
      utilization: number;
      /** pTokens in the wallet; undefined while the wallet is unknown. */
      shares: bigint | undefined;
      /** The pool's shares as VaultManager collateral, when they are accepted. */
      collateral: CollateralState | undefined;
      /** Shares posted as collateral: undefined while unknown, 0 when the pool's shares are not collateral. */
      posted: bigint | undefined;
      supplyBlocked: string | null;
      postBlocked: string | null;
      /** Known to be empty: an unread balance never disables an action. */
      noShares: boolean;
      noPosted: boolean;
    }
  | {
      kind: 'collateral';
      collateral: CollateralState;
      price: number;
      wallet: bigint | undefined;
      posted: bigint | undefined;
      postBlocked: string | null;
      noWallet: boolean;
      noPosted: boolean;
    };

/** Every pool, then the plain hub collateral (BTC: no pool and no interest, posted as the token itself). */
export function marketEntries({
  protocol,
  prices,
  balances,
  position,
  flags,
  connected,
}: {
  protocol: ProtocolState;
  prices: UsdPrices | undefined;
  balances: WalletBalances | undefined;
  position: PositionState | undefined;
  flags: HubFlags | undefined;
  connected: boolean;
}): MarketEntry[] {
  // A balance not read yet (or not readable) is unknown: it must not disable the actions as if it were zero.
  const none = (amount: bigint | undefined) => connected && amount === 0n;
  const pools = protocol.markets.map((m): MarketEntry => {
    const collateral = protocol.collaterals.find((c) => c.token.toLowerCase() === m.pool.toLowerCase());
    const shares = balances?.hub.tokens[m.receiptSymbol];
    const posted = collateral ? position?.collateral.find((c) => c.id === collateral.id)?.balance : 0n;
    return {
      kind: 'pool',
      market: m,
      price: prices?.[m.symbol as 'MUSD' | 'MEZO'] ?? 0,
      utilization: m.totalAssets > 0n ? Number(m.totalBorrows) / Number(m.totalAssets) : 0,
      shares,
      collateral,
      posted,
      supplyBlocked: supplyBlocked(m, flags),
      postBlocked: collateral ? postBlocked(collateral) : null,
      noShares: none(shares),
      noPosted: none(posted),
    };
  });
  const plain = protocol.collaterals
    .filter((c) => !c.isRemote && !c.isShare)
    .map((c): MarketEntry => {
      const symbol = symbolForPriceKey(c.priceKey);
      const wallet = balances?.hub.tokens[c.symbol];
      const posted = position?.collateral.find((x) => x.id === c.id)?.balance;
      return {
        kind: 'collateral',
        collateral: c,
        price: symbol ? (prices?.[symbol] ?? 0) : 0,
        wallet,
        posted,
        postBlocked: postBlocked(c),
        noWallet: none(wallet),
        noPosted: none(posted),
      };
    });
  return [...pools, ...plain];
}

export function Markets() {
  const { openModal, go } = useUi();
  const { isConnected } = useAccount();
  const protocol = useProtocol().data;
  const prices = usePrices().data?.prices;
  const balances = useWalletBalances().data;
  const flags = useHubFlags().data;
  const { position } = useValuedPosition();
  const [view, setView] = useMarketsView();
  const entries = protocol ? marketEntries({ protocol, prices, balances, position, flags, connected: isConnected }) : [];
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const musdBlocked = musd ? supplyBlocked(musd, flags) : null;
  // The example supplies 10,000 MUSD; a wallet holding less is offered what it has instead of an amount it cannot send.
  const flowA = musd ? 10_000n * 10n ** BigInt(musd.decimals) : 0n;
  const walletMusd = musd ? (balances?.hub.tokens[musd.symbol] ?? 0n) : 0n;
  const flowASupply = walletMusd > 0n && walletMusd < flowA ? walletMusd : flowA;

  return (
    <>
      <PageTitle
        eyebrow="LIQUIDITY"
        title="Markets & vaults"
        subtitle="Supply MUSD or MEZO and receive pMUSD / pMEZO — ERC-4626 shares whose exchange rate grows with borrower interest. Post them as collateral and they keep earning."
        right={
          musd && (
            <button
              className="button button--dark"
              onClick={() => openModal({ type: 'supply', marketId: musd.id })}
              disabled={musdBlocked !== null}
              title={musdBlocked ?? undefined}
            >
              <Plus size={15} /> Supply MUSD
            </button>
          )
        }
      />
      <SummaryStrip
        snapshot={
          <>
            ERC-4626 VAULTS <i>/</i> COMPOSABLE RECEIPTS
          </>
        }
        time={HUB.label}
        icon={LockKeyhole}
      />
      {!HUB_DEPLOYED && <NotDeployed />}
      {HUB_DEPLOYED && !protocol && <HubPending what="markets" />}

      {musd && (
        <div className="vault-banner">
          <div className="vault-emblem">
            <Coins size={23} />
          </div>
          <div>
            <span className="overline">YIELD RECEIPT TOKENS</span>
            <h2>Your deposit earns its way forward.</h2>
            <p>
              Interest paid by borrowers raises totalAssets; every pToken share redeems for more underlying. pTokens are standard ERC-20s usable across Mezo
              DeFi.
            </p>
          </div>
          <div className="vault-rate">
            <span>pMUSD / MUSD</span>
            <strong>{fmt(units(musd.exchangeRate, musd.decimals), 6)}</strong>
            <small>
              <TrendingUp size={12} /> {fmtApy(perSecondToApy(musd.supplyRatePerSecond))} supply APY
            </small>
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="markets-toolbar">
            <ViewToggle view={view} onChange={setView} />
          </div>
          {view === 'list' ? <MarketList entries={entries} /> : <MarketGrid entries={entries} />}
        </>
      )}

      {musd && (
        <div className="two-col-note">
          <div className="panel explainer-panel">
            <span className="overline">HOW RATES WORK</span>
            <h3>Suppliers earn what borrowers pay.</h3>
            <p>{ratesExplainer(protocol!)}</p>
            <button className="text-link" onClick={() => go('architecture')}>
              Protocol architecture <ArrowRight size={13} />
            </button>
          </div>
          <div className="panel example-panel">
            <span className="overline">EXAMPLE · PASSIVE LP</span>
            <div className="example-math">
              <span>
                10,000 <small>MUSD supplied</small>
              </span>
              <ArrowRight size={20} />
              <span>
                {fmt(10_000 / units(musd.exchangeRate, musd.decimals), 2)} <small>pMUSD received</small>
              </span>
            </div>
            <p>At the live exchange rate of {fmt(units(musd.exchangeRate, musd.decimals), 6)} MUSD per pMUSD.</p>
            <button
              className="button button--outline"
              onClick={() => openModal({ type: 'supply', marketId: musd.id, preset: toInput(flowASupply, musd.decimals) })}
              disabled={musdBlocked !== null}
              title={musdBlocked ?? undefined}
            >
              Supply {fmt(units(flowASupply, musd.decimals), 2)} MUSD <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ViewToggle({ view, onChange }: { view: MarketsView; onChange: (view: MarketsView) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="Layout">
      <button type="button" aria-pressed={view === 'grid'} onClick={() => onChange('grid')}>
        <LayoutGrid size={14} /> Grid
      </button>
      <button type="button" aria-pressed={view === 'list'} onClick={() => onChange('list')}>
        <List size={14} /> List
      </button>
    </div>
  );
}

function MarketGrid({ entries }: { entries: MarketEntry[] }) {
  return (
    <div className="market-card-grid">
      {entries.map((e) =>
        e.kind === 'pool' ? <PoolCard key={`pool-${e.market.id}`} entry={e} /> : <CollateralCard key={`collateral-${e.collateral.id}`} entry={e} />,
      )}
    </div>
  );
}

function PoolCard({ entry }: { entry: Extract<MarketEntry, { kind: 'pool' }> }) {
  const { openModal } = useUi();
  const { market: m, price, utilization, shares, collateral, posted } = entry;
  return (
    <article className="market-detail-card">
      <div className="market-detail-top">
        <div className="asset-cell">
          <TokenLogo symbol={m.symbol} size={31} />
          <span>
            <b>{m.symbol}</b>
            <small>
              {m.receiptSymbol} · {money(price, price < 1 ? 5 : 2)} · <AddressLink network={HUB} address={m.pool} />
            </small>
          </span>
        </div>
      </div>
      <div className="market-yield-row">
        <div>
          <span>SUPPLY APY</span>
          <strong className="apy-value">{fmtApy(perSecondToApy(m.supplyRatePerSecond))}</strong>
        </div>
        <div>
          <span>BORROW APY</span>
          <strong>{fmtApy(perSecondToApy(m.borrowRatePerSecond))}</strong>
        </div>
        <div>
          <span>UTILIZATION</span>
          <strong>{pct(utilization)}</strong>
        </div>
      </div>
      <div className="rate-box">
        <span>
          <TokenLogo symbol={m.receiptSymbol} size={16} /> {m.receiptSymbol} exchange rate
        </span>
        <b>
          1 {m.receiptSymbol} <i>=</i> {fmt(units(m.exchangeRate, m.decimals), 6)} {m.symbol}
        </b>
        <small>
          Rises as borrower interest accrues · reserves {fmt(units(m.totalReserves, m.decimals), 2)} {m.symbol}
        </small>
      </div>
      <div className="pool-row">
        <span>Supplied</span>
        <b>{compactUsd(units(m.totalAssets, m.decimals) * price)}</b>
        <span>Available liquidity</span>
        <b>
          {fmt(units(m.cash, m.decimals), 0)} {m.symbol}
        </b>
      </div>
      <div className="user-deposit">
        <span>In wallet</span>
        <strong>
          {shares === undefined ? '—' : fmt(pTokenUnits(m, shares), 4)}{' '}
          <small>
            {m.symbol} as {m.receiptSymbol}
          </small>
        </strong>
        <span>Posted as collateral</span>
        <strong>
          {posted === undefined ? '—' : fmt(pTokenUnits(m, posted), 4)} <small>{m.symbol}</small>
        </strong>
      </div>
      <div className="market-actions">
        <button
          className="button button--dark"
          onClick={() => openModal({ type: 'supply', marketId: m.id })}
          disabled={entry.supplyBlocked !== null}
          title={entry.supplyBlocked ?? undefined}
        >
          Supply
        </button>
        <button className="button button--light" onClick={() => openModal({ type: 'withdraw', marketId: m.id })} disabled={entry.noShares}>
          Withdraw
        </button>
      </div>
      {collateral && (
        <div className="market-actions">
          <button
            className="button button--outline"
            onClick={() => openModal({ type: 'post', collateralId: collateral.id })}
            disabled={entry.noShares || entry.postBlocked !== null}
            title={entry.postBlocked ?? undefined}
          >
            Use as collateral · LTV {collateral.ltvBps / 100}%
          </button>
          <button className="button button--light" onClick={() => openModal({ type: 'unpost', collateralId: collateral.id })} disabled={entry.noPosted}>
            Remove
          </button>
        </div>
      )}
      {(entry.supplyBlocked || entry.postBlocked) && <p className="action-blocked">{entry.supplyBlocked ?? entry.postBlocked}</p>}
    </article>
  );
}

function CollateralCard({ entry }: { entry: Extract<MarketEntry, { kind: 'collateral' }> }) {
  const { openModal, go } = useUi();
  const { collateral: c, price, wallet, posted } = entry;
  return (
    <article className="market-detail-card">
      <div className="market-detail-top">
        <div className="asset-cell">
          <TokenLogo symbol={c.symbol} size={31} />
          <span>
            <b>{c.symbol} collateral</b>
            <small>
              Held on the hub · {money(price, 0)} · <AddressLink network={HUB} address={c.token} />
            </small>
          </span>
        </div>
      </div>
      <div className="market-yield-row">
        <div>
          <span>MAX LTV</span>
          <strong>{c.ltvBps / 100}%</strong>
        </div>
        <div>
          <span>LIQUIDATION</span>
          <strong>{c.ltBps / 100}%</strong>
        </div>
        <div>
          <span>BONUS</span>
          <strong>{c.bonusBps / 100}%</strong>
        </div>
      </div>
      <div className="rate-box">
        <span>Mezo's native {c.symbol}, locked in VaultManager</span>
        <b>
          Total posted {fmt(units(c.total, c.decimals), 4)} {c.symbol}
        </b>
        <small>
          Earns no interest; borrow MUSD or MEZO against it, or take it to {Math.floor((1 / (1 - c.ltvBps / 10_000)) * 10) / 10}× on the Leverage desk.
        </small>
      </div>
      <div className="user-deposit">
        <span>In wallet</span>
        <strong>
          {wallet === undefined ? '—' : fmt(units(wallet, c.decimals), 6)} <small>{c.symbol}</small>
        </strong>
        <span>Posted as collateral</span>
        <strong>
          {posted === undefined ? '—' : fmt(units(posted, c.decimals), 6)} <small>{c.symbol}</small>
        </strong>
      </div>
      <div className="market-actions">
        <button
          className="button button--dark"
          onClick={() => openModal({ type: 'post', collateralId: c.id })}
          disabled={entry.noWallet || entry.postBlocked !== null}
          title={entry.postBlocked ?? undefined}
        >
          Post {c.symbol}
        </button>
        <button className="button button--light" onClick={() => openModal({ type: 'unpost', collateralId: c.id })} disabled={entry.noPosted}>
          Remove
        </button>
      </div>
      {entry.postBlocked && <p className="action-blocked">{entry.postBlocked}</p>}
      <div className="market-actions">
        <button className="button button--outline" onClick={() => go('loop')}>
          Open a leveraged {c.symbol} position <ArrowRight size={13} />
        </button>
      </div>
    </article>
  );
}

/** The markets as one table: a row per pool and per hub collateral, with the actions of its card. */
export function MarketList({ entries }: { entries: MarketEntry[] }) {
  const { openModal, go } = useUi();
  return (
    <section className="panel market-list">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ASSET</th>
              <th>SUPPLY APY</th>
              <th>BORROW APY</th>
              <th>UTILIZATION</th>
              <th>SIZE</th>
              <th>LIQUIDITY</th>
              <th>IN WALLET</th>
              <th>POSTED</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              if (e.kind === 'pool') {
                const { market: m, price, collateral } = e;
                const blocked = e.supplyBlocked ?? e.postBlocked;
                return (
                  <tr key={`pool-${m.id}`}>
                    <td>
                      <div className="asset-cell">
                        <TokenLogo symbol={m.symbol} />
                        <span>
                          <b>{m.symbol}</b>
                          <small>
                            {m.receiptSymbol} · {money(price, price < 1 ? 5 : 2)}
                          </small>
                          {blocked && <small className="list-blocked">{blocked}</small>}
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
                          <i style={{ width: pct(e.utilization) }} />
                        </span>
                        <span>{pct(e.utilization, 0)}</span>
                      </div>
                    </td>
                    <td>{compactUsd(units(m.totalAssets, m.decimals) * price)}</td>
                    <td>
                      {fmt(units(m.cash, m.decimals), 0)} {m.symbol}
                    </td>
                    <td>{e.shares === undefined ? '—' : `${fmt(pTokenUnits(m, e.shares), 4)} ${m.symbol}`}</td>
                    <td>{e.posted === undefined ? '—' : `${fmt(pTokenUnits(m, e.posted), 4)} ${m.symbol}`}</td>
                    <td>
                      <div className="list-actions">
                        <button
                          className="button button--dark button--small"
                          onClick={() => openModal({ type: 'supply', marketId: m.id })}
                          disabled={e.supplyBlocked !== null}
                          title={e.supplyBlocked ?? undefined}
                        >
                          Supply
                        </button>
                        <button
                          className="button button--light button--small"
                          onClick={() => openModal({ type: 'withdraw', marketId: m.id })}
                          disabled={e.noShares}
                        >
                          Withdraw
                        </button>
                        {collateral && (
                          <>
                            <button
                              className="button button--outline button--small"
                              onClick={() => openModal({ type: 'post', collateralId: collateral.id })}
                              disabled={e.noShares || e.postBlocked !== null}
                              title={e.postBlocked ?? `Use ${m.receiptSymbol} as collateral at ${collateral.ltvBps / 100}% LTV`}
                            >
                              Collateral
                            </button>
                            <button
                              className="button button--light button--small"
                              onClick={() => openModal({ type: 'unpost', collateralId: collateral.id })}
                              disabled={e.noPosted}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              }
              const { collateral: c, price } = e;
              return (
                <tr key={`collateral-${c.id}`}>
                  <td>
                    <div className="asset-cell">
                      <TokenLogo symbol={c.symbol} />
                      <span>
                        <b>{c.symbol}</b>
                        <small>collateral · {money(price, 0)}</small>
                        {e.postBlocked && <small className="list-blocked">{e.postBlocked}</small>}
                      </span>
                    </div>
                  </td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>{compactUsd(units(c.total, c.decimals) * price)}</td>
                  <td>—</td>
                  <td>{e.wallet === undefined ? '—' : `${fmt(units(e.wallet, c.decimals), 6)} ${c.symbol}`}</td>
                  <td>{e.posted === undefined ? '—' : `${fmt(units(e.posted, c.decimals), 6)} ${c.symbol}`}</td>
                  <td>
                    <div className="list-actions">
                      <button
                        className="button button--dark button--small"
                        onClick={() => openModal({ type: 'post', collateralId: c.id })}
                        disabled={e.noWallet || e.postBlocked !== null}
                        title={e.postBlocked ?? `Post ${c.symbol} at ${c.ltvBps / 100}% LTV`}
                      >
                        Post
                      </button>
                      <button
                        className="button button--light button--small"
                        onClick={() => openModal({ type: 'unpost', collateralId: c.id })}
                        disabled={e.noPosted}
                      >
                        Remove
                      </button>
                      <button className="button button--outline button--small" onClick={() => go('loop')} title={`Open a leveraged ${c.symbol} position`}>
                        Leverage
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
