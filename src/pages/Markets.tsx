import { ArrowRight, Clock3, Coins, LockKeyhole, MoreHorizontal, Plus, TrendingUp } from 'lucide-react';
import { PageTitle, SummaryStrip } from '../components/ui';
import { LP_DEPOSIT, MARKETS, PRICES } from '../data/mock';
import { accrueInterest, marketStats } from '../lib/engine';
import { fmt, money, pct } from '../lib/format';
import { sharesForAssets } from '../lib/protocol';
import { useApp } from '../state/AppContext';

const ACCRUAL_DAYS = 30;

export function Markets() {
  const { state, summary, go, openAmount, showToast, run } = useApp();
  const { rates, previousRates, account } = state;
  const rateChange = (rates.pMUSD / previousRates.pMUSD - 1) * 100;

  return (
    <>
      <PageTitle
        eyebrow="LIQUIDITY / 01"
        title="Markets & vaults"
        subtitle="Supply MUSD or MEZO. Receive an interest-bearing pToken whose exchange rate grows with simulated borrower interest."
        right={
          <button className="button button--dark" onClick={() => openAmount('supply', 'MUSD')}>
            <Plus size={15} /> Supply assets
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            ERC-4626 STYLE VAULTS <i>/</i> COMPOSABLE RECEIPTS
          </>
        }
        time="Mezo Hub"
        icon={LockKeyhole}
      />

      <div className="vault-banner">
        <div className="vault-emblem">
          <Coins size={23} />
        </div>
        <div>
          <span className="overline">YIELD RECEIPT TOKENS</span>
          <h2>Your deposit earns its way forward.</h2>
          <p>pMUSD and pMEZO represent vault shares. As borrower interest accrues, each share redeems for more of its underlying asset.</p>
          <button className="button button--outline accrue-button" onClick={() => run((s) => accrueInterest(s, ACCRUAL_DAYS))}>
            <Clock3 size={14} /> Simulate {ACCRUAL_DAYS} days of interest
          </button>
        </div>
        <div className="vault-rate">
          <span>pMUSD / MUSD</span>
          <strong>{rates.pMUSD.toFixed(4)}</strong>
          <small>
            <TrendingUp size={12} /> +{rateChange.toFixed(3)}% vs previous
          </small>
        </div>
      </div>

      <div className="market-card-grid">
        {MARKETS.map((market) => {
          const stats = marketStats(market.symbol);
          const rate = rates[market.receipt];
          const shares = account.earnShares[market.receipt];
          const deposited = summary.earn[market.symbol];
          return (
            <article className="market-detail-card" key={market.symbol}>
              <div className="market-detail-top">
                <div className="asset-cell">
                  <span className="asset-icon asset-icon--large" style={{ background: market.color }}>
                    {market.icon}
                  </span>
                  <span>
                    <b>{market.symbol}</b>
                    <small>
                      {market.name} · {market.kind} · {money(PRICES[market.symbol], 2)}
                    </small>
                  </span>
                </div>
                <button
                  className="icon-button"
                  aria-label={`More about ${market.symbol}`}
                  onClick={() => showToast(`${market.symbol} market data is simulated`)}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
              <div className="market-yield-row">
                <div>
                  <span>SUPPLY APY</span>
                  <strong className="apy-value">
                    {stats.totalSupplyApy.toFixed(2)}
                    <small>%</small>
                  </strong>
                  <em className="apy-split">
                    {stats.baseSupplyApy.toFixed(2)}% interest + {market.rewardApr.toFixed(2)}% MEZO
                  </em>
                </div>
                <div>
                  <span>BORROW APY</span>
                  <strong>
                    {market.borrowApy.toFixed(2)}
                    <small>%</small>
                  </strong>
                </div>
                <div>
                  <span>UTILIZATION</span>
                  <strong>
                    {fmt(stats.utilization * 100, 0)}
                    <small>%</small>
                  </strong>
                </div>
              </div>
              <div className="rate-box">
                <span>
                  <span className="receipt-glyph">p</span> {market.receipt} exchange rate
                </span>
                <b>
                  1 {market.receipt} <i>=</i> {rate.toFixed(4)} {market.symbol}
                </b>
                <small>Previous {previousRates[market.receipt].toFixed(4)} · rate increases as interest accrues</small>
              </div>
              <div className="pool-row">
                <span>Pool size</span>
                <b>
                  {fmt(market.supplied)} {market.symbol}
                </b>
                <span>Available liquidity</span>
                <b>
                  {fmt(stats.liquidity)} {market.symbol}
                </b>
              </div>
              <div className="user-deposit">
                <span>Your supplied balance</span>
                <strong>
                  {fmt(deposited, 2)} <small>{market.symbol}</small>
                </strong>
                <span>Receipt shares held</span>
                <strong>
                  {fmt(shares, 2)} <small>{market.receipt}</small>
                </strong>
              </div>
              <div className="market-actions">
                <button className="button button--dark" onClick={() => openAmount('supply', market.symbol)}>
                  Supply {market.symbol}
                </button>
                <button className="button button--light" onClick={() => openAmount('withdraw', market.symbol)} disabled={shares <= 0}>
                  Withdraw
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className="two-col-note">
        <div className="panel explainer-panel">
          <span className="overline">COMPOSABLE BY DESIGN</span>
          <h3>One receipt. More places to work.</h3>
          <p>
            pMUSD and pMEZO follow an ERC-4626-style share model in this product concept. Base interest ({pct(marketStats('MUSD').baseSupplyApy / 100, 2)} for
            MUSD) never exceeds what borrowers pay: borrow APY × utilization × (1 − 10% reserve factor).
          </p>
          <button className="text-link" onClick={() => go('architecture')}>
            Explore protocol architecture <ArrowRight size={13} />
          </button>
        </div>
        <div className="panel example-panel">
          <span className="overline">LP SCENARIO / SIMULATED</span>
          <div className="example-math">
            <span>
              {fmt(LP_DEPOSIT)} <small>MUSD supplied</small>
            </span>
            <ArrowRight size={20} />
            <span>
              {fmt(sharesForAssets(LP_DEPOSIT, rates.pMUSD), 2)} <small>pMUSD received</small>
            </span>
          </div>
          <p>At the current demo exchange rate of {rates.pMUSD.toFixed(4)} MUSD per pMUSD. Future share value accrues as modeled interest is added.</p>
          <button className="button button--outline" onClick={() => openAmount('supply', 'MUSD', String(LP_DEPOSIT))}>
            Preview this supply <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </>
  );
}
