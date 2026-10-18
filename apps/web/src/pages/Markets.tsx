import { ArrowRight, Coins, LockKeyhole, Plus, TrendingUp } from 'lucide-react';
import { useAccount } from 'wagmi';
import { perSecondToAnnual, pTokenUnits } from '@mezodot/sdk';
import { TokenLogo } from '../components/Logos';
import { AddressLink, NotDeployed, PageTitle, SummaryStrip } from '../components/ui';
import { HUB, HUB_DEPLOYED } from '../chain/env';
import { usePrices, useProtocol, useValuedPosition, useWalletBalances } from '../data/hooks';
import { toInput } from '../lib/amount';
import { compactUsd, fmt, fmtApy, money, pct, units } from '../lib/format';
import { useUi } from '../state/UiContext';

export function Markets() {
  const { openModal, go } = useUi();
  const { isConnected } = useAccount();
  const protocol = useProtocol().data;
  const prices = usePrices().data?.prices;
  const balances = useWalletBalances().data;
  const { position } = useValuedPosition();
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  // PRD flow A supplies 10,000 MUSD; a wallet holding less is offered what it has instead of an amount it cannot send.
  const flowA = musd ? 10_000n * 10n ** BigInt(musd.decimals) : 0n;
  const walletMusd = musd ? (balances?.hub.tokens[musd.symbol] ?? 0n) : 0n;
  const flowASupply = walletMusd > 0n && walletMusd < flowA ? walletMusd : flowA;

  return (
    <>
      <PageTitle
        eyebrow="LIQUIDITY / 01"
        title="Markets & vaults"
        subtitle="Supply MUSD or MEZO and receive pMUSD / pMEZO — ERC-4626 shares whose exchange rate grows with borrower interest. Post them as collateral and they keep earning."
        right={
          musd && (
            <button className="button button--dark" onClick={() => openModal({ type: 'supply', marketId: musd.id })}>
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
              <TrendingUp size={12} /> {fmtApy(perSecondToAnnual(musd.supplyRatePerSecond))} supply APY
            </small>
          </div>
        </div>
      )}

      <div className="market-card-grid">
        {(protocol?.markets ?? []).map((m) => {
          const util = m.totalAssets > 0n ? Number(m.totalBorrows) / Number(m.totalAssets) : 0;
          const price = prices?.[m.symbol as 'MUSD' | 'MEZO'] ?? 0;
          const shares = balances?.hub.tokens[m.receiptSymbol] ?? 0n;
          const collateral = protocol!.collaterals.find((c) => c.token.toLowerCase() === m.pool.toLowerCase());
          const posted = collateral ? (position?.collateral.find((c) => c.id === collateral.id)?.balance ?? 0n) : 0n;
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
                  <strong className="apy-value">{fmtApy(perSecondToAnnual(m.supplyRatePerSecond))}</strong>
                </div>
                <div>
                  <span>BORROW APY</span>
                  <strong>{fmtApy(perSecondToAnnual(m.borrowRatePerSecond))}</strong>
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
                  {fmt(pTokenUnits(m, shares), 4)}{' '}
                  <small>
                    {m.symbol} as {m.receiptSymbol}
                  </small>
                </strong>
                <span>Posted as collateral</span>
                <strong>
                  {fmt(pTokenUnits(m, posted), 4)} <small>{m.symbol}</small>
                </strong>
              </div>
              <div className="market-actions">
                <button className="button button--dark" onClick={() => openModal({ type: 'supply', marketId: m.id })}>
                  Supply
                </button>
                <button
                  className="button button--light"
                  onClick={() => openModal({ type: 'withdraw', marketId: m.id })}
                  disabled={isConnected && shares === 0n}
                >
                  Withdraw
                </button>
              </div>
              {collateral && (
                <div className="market-actions">
                  <button
                    className="button button--outline"
                    onClick={() => openModal({ type: 'post', collateralId: collateral.id })}
                    disabled={isConnected && shares === 0n}
                  >
                    Use as collateral · LTV {collateral.ltvBps / 100}%
                  </button>
                  <button
                    className="button button--light"
                    onClick={() => openModal({ type: 'unpost', collateralId: collateral.id })}
                    disabled={isConnected && posted === 0n}
                  >
                    Remove
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {musd && (
        <div className="two-col-note">
          <div className="panel explainer-panel">
            <span className="overline">HOW RATES WORK</span>
            <h3>Suppliers earn what borrowers pay.</h3>
            <p>
              Kinked curve per pool (MUSD: 6% at 80% utilization, steep above). Supply APY = borrow APY × utilization × (1 − 10% reserve factor). Flash-loan
              fees (0.09%) go to reserves.
            </p>
            <button className="text-link" onClick={() => go('architecture')}>
              Protocol architecture <ArrowRight size={13} />
            </button>
          </div>
          <div className="panel example-panel">
            <span className="overline">PRD FLOW A · PASSIVE LP</span>
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
            >
              Supply {fmt(units(flowASupply, musd.decimals), 2)} MUSD <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
