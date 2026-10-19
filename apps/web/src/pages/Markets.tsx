import { ArrowRight, Coins, LockKeyhole, Plus, TrendingUp } from 'lucide-react';
import { useAccount } from 'wagmi';
import { BPS, FLASH_FEE_BPS, perSecondToApy, pTokenUnits, symbolForPriceKey, type ProtocolState } from '@mezodot/sdk';
import { TokenLogo } from '../components/Logos';
import { HubPending } from '../components/StatusBanners';
import { AddressLink, NotDeployed, PageTitle, SummaryStrip } from '../components/ui';
import { HUB, HUB_DEPLOYED } from '../chain/env';
import { postBlocked, supplyBlocked, useHubFlags } from '../data/guards';
import { usePrices, useProtocol, useValuedPosition, useWalletBalances } from '../data/hooks';
import { toInput } from '../lib/amount';
import { compactUsd, fmt, fmtApy, money, pct, units } from '../lib/format';
import { useUi } from '../state/UiContext';

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

export function Markets() {
  const { openModal, go } = useUi();
  const { isConnected } = useAccount();
  const protocol = useProtocol().data;
  const prices = usePrices().data?.prices;
  const balances = useWalletBalances().data;
  const flags = useHubFlags().data;
  const { position } = useValuedPosition();
  // A balance not read yet (or not readable) is unknown: it must not disable the actions as if it were zero.
  const none = (amount: bigint | undefined) => isConnected && amount === 0n;
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

      <div className="market-card-grid">
        {(protocol?.markets ?? []).map((m) => {
          const util = m.totalAssets > 0n ? Number(m.totalBorrows) / Number(m.totalAssets) : 0;
          const price = prices?.[m.symbol as 'MUSD' | 'MEZO'] ?? 0;
          const shares = balances?.hub.tokens[m.receiptSymbol];
          const collateral = protocol!.collaterals.find((c) => c.token.toLowerCase() === m.pool.toLowerCase());
          const posted = collateral ? position?.collateral.find((c) => c.id === collateral.id)?.balance : 0n;
          const supplyReason = supplyBlocked(m, flags);
          const postReason = collateral ? postBlocked(collateral) : null;
          return (
            <article className="market-detail-card" key={m.id}>
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
                  <strong>{pct(util)}</strong>
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
                  disabled={supplyReason !== null}
                  title={supplyReason ?? undefined}
                >
                  Supply
                </button>
                <button className="button button--light" onClick={() => openModal({ type: 'withdraw', marketId: m.id })} disabled={none(shares)}>
                  Withdraw
                </button>
              </div>
              {collateral && (
                <div className="market-actions">
                  <button
                    className="button button--outline"
                    onClick={() => openModal({ type: 'post', collateralId: collateral.id })}
                    disabled={none(shares) || postReason !== null}
                    title={postReason ?? undefined}
                  >
                    Use as collateral · LTV {collateral.ltvBps / 100}%
                  </button>
                  <button className="button button--light" onClick={() => openModal({ type: 'unpost', collateralId: collateral.id })} disabled={none(posted)}>
                    Remove
                  </button>
                </div>
              )}
              {(supplyReason || postReason) && <p className="action-blocked">{supplyReason ?? postReason}</p>}
            </article>
          );
        })}
        {/* Plain hub collateral (BTC): no pool and no interest, posted as the token itself. */}
        {(protocol?.collaterals ?? [])
          .filter((c) => !c.isRemote && !c.isShare)
          .map((c) => {
            const symbol = symbolForPriceKey(c.priceKey);
            const price = symbol ? (prices?.[symbol] ?? 0) : 0;
            const posted = position?.collateral.find((x) => x.id === c.id)?.balance;
            const wallet = balances?.hub.tokens[c.symbol];
            const postReason = postBlocked(c);
            return (
              <article className="market-detail-card" key={`collateral-${c.id}`}>
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
                    Earns no interest; borrow MUSD or MEZO against it, or take it to {Math.floor((1 / (1 - c.ltvBps / 10_000)) * 10) / 10}× on the Leverage
                    desk.
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
                    disabled={none(wallet) || postReason !== null}
                    title={postReason ?? undefined}
                  >
                    Post {c.symbol}
                  </button>
                  <button className="button button--light" onClick={() => openModal({ type: 'unpost', collateralId: c.id })} disabled={none(posted)}>
                    Remove
                  </button>
                </div>
                {postReason && <p className="action-blocked">{postReason}</p>}
                <div className="market-actions">
                  <button className="button button--outline" onClick={() => go('loop')}>
                    Open a leveraged {c.symbol} position <ArrowRight size={13} />
                  </button>
                </div>
              </article>
            );
          })}
      </div>

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
