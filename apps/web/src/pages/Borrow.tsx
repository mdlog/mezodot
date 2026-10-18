import { useState } from 'react';
import { ArrowRight, ArrowUpRight, LockKeyhole, Network, Shield, ShieldAlert } from 'lucide-react';
import { useAccount } from 'wagmi';
import { maxUint256 } from 'viem';
import { healthStatus, perSecondToApy, symbolForPriceKey } from '@mezodot/sdk';
import { TokenLogo } from '../components/Logos';
import { HubPending } from '../components/StatusBanners';
import { AmountInput, ConnectGate, NotDeployed, PageTitle, PanelTitle, PriceNotice, SummaryStrip } from '../components/ui';
import { HUB_DEPLOYED, spokeByWormholeChain } from '../chain/env';
import { REPAY_WITH_COLLATERAL, borrowSteps, repayWithCollateralSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { borrowBlocked, borrowRoom, repayWithSharesPlan, useHubFlags } from '../data/guards';
import { useHubClient, useValuedPosition } from '../data/hooks';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { fmt, fmtApy, fmtHealth, money, pct, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import { HealthGauge, LtvMeter } from './shared';

export function Borrow() {
  const { go, openModal } = useUi();
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const { valued, protocol, prices, position, unpriced, unpricedDebts, relayError } = useValuedPosition();
  const flags = useHubFlags().data;
  const [marketId, setMarketId] = useState(0);
  const [amount, setAmount] = useState('');

  const market = protocol?.markets[marketId];
  const priceSymbol = market ? symbolForPriceKey(market.priceKey) : undefined;
  const price = priceSymbol ? (prices?.[priceSymbol] ?? 0) : 0;
  const availableUnits = valued && price > 0 ? Math.max(0, valued.availableUsd / price) : 0;
  const liquidity = market ? units(market.cash, market.decimals) : 0;
  // Exact bigint limit: fresh-price headroom (floored, 0.1% margin) capped by pool cash and the borrow cap.
  const maxBorrow = market ? [floorUnits(availableUnits * 0.999, market.decimals), market.cash, borrowRoom(market)].reduce((a, b) => (b < a ? b : a)) : 0n;
  const blocked = market ? borrowBlocked(market, flags) : null;

  const parsed = market ? parseInput(amount, market.decimals) : null;
  const value = parsed && market ? units(parsed, market.decimals) : 0;
  // VaultManager prices debt strictly: while a debt has no usable price every borrow reverts (PriceNotice says why).
  const invalid = parsed === null || parsed > maxBorrow || blocked !== null || unpricedDebts.length > 0;
  const hfAfter = valued ? (valued.debtUsd + value * price > 0 ? valued.adjustedCollateralUsd / (valued.debtUsd + value * price) : Infinity) : Infinity;
  const status = healthStatus(valued?.healthFactor ?? Infinity);
  const debt = market ? (position?.debts.find((d) => d.marketId === market.id)?.amount ?? 0n) : 0n;
  const ltvMarks = protocol?.collaterals.filter((c) => valued?.collateral.find((v) => v.collateral.id === c.id && v.balance > 0n)) ?? [];
  const maxLtv = valued && valued.collateralUsd > 0 ? valued.borrowLimitUsd / valued.collateralUsd : 0.75;
  const liqLtv = valued && valued.collateralUsd > 0 ? valued.adjustedCollateralUsd / valued.collateralUsd : 0.8;

  // Debt in a pool can also be repaid by burning posted shares of that pool (pMUSD for MUSD): no MUSD needed.
  const shareCollateral = market ? protocol?.collaterals.find((c) => c.isShare && c.token.toLowerCase() === market.pool.toLowerCase()) : undefined;
  const postedShares = shareCollateral ? (position?.collateral.find((c) => c.id === shareCollateral.id)?.balance ?? 0n) : 0n;
  const sharePlan = REPAY_WITH_COLLATERAL && market && shareCollateral && position ? repayWithSharesPlan(market, shareCollateral, position) : null;
  const canRepayWithShares = sharePlan !== null && debt > 0n && postedShares > 0n;

  const borrow = async () => {
    if (!address || !hub || !market || !parsed || !protocol) return;
    const result = await run(`Borrow ${market.symbol}`, borrowSteps({ account: address, hub, protocol, position: position ?? null }, market, parsed));
    if (result.ok) setAmount('');
  };

  const repayWithShares = async () => {
    if (!address || !hub || !market || !protocol || !shareCollateral) return;
    const ctx = { account: address, hub, protocol, position: position ?? null };
    await run(`Repay ${market.symbol} with ${shareCollateral.symbol}`, repayWithCollateralSteps(ctx, market, shareCollateral, maxUint256));
  };

  return (
    <>
      <PageTitle
        eyebrow="CAPITAL / 03"
        title="Borrow against your position."
        subtitle="Borrow MUSD or MEZO on the Mezo Hub against pTokens and collateral locked on Base or Ethereum. One health factor across every chain."
        right={
          market && (
            <span className="availability-pill">
              <i /> {market.symbol} liquidity · {fmt(liquidity, 0)}
            </span>
          )
        }
      />
      <SummaryStrip
        snapshot={
          <>
            VAULTMANAGER <i>/</i> CROSS-CHAIN HEALTH FACTOR
          </>
        }
        time="Prices: Pyth on Mezo · Supra pull for ETH/USDC"
        icon={Shield}
      />
      {!HUB_DEPLOYED && <NotDeployed />}
      {HUB_DEPLOYED && !protocol && <HubPending what="your borrowing position" />}

      <div className="borrow-layout">
        <section className="panel borrow-form-panel">
          <PanelTitle label="Borrow" meta="Mezo Hub · MezodotPool" />
          <div className="borrow-from">
            <div>
              <span className="field-label">COLLATERAL POSITION</span>
              {(valued?.collateral.filter((c) => c.balance > 0n) ?? []).map((c) => (
                <div className="collateral-detail" key={c.collateral.id}>
                  <TokenLogo symbol={c.collateral.symbol} network={spokeByWormholeChain(c.collateral.chainId)?.name} size={29} />
                  <span>
                    <b>
                      {fmt(c.units, 4)} {c.collateral.symbol}
                    </b>
                    <small>
                      {c.collateral.isRemote ? `${spokeByWormholeChain(c.collateral.chainId)?.label ?? 'Spoke'} · ` : 'Mezo Hub · '}
                      {money(c.valueUsd)} · LTV {c.collateral.ltvBps / 100}%
                    </small>
                  </span>
                </div>
              ))}
              {valued && valued.collateralUsd === 0 && <p className="muted-note">No collateral posted yet.</p>}
            </div>
            <div className="borrow-add-links">
              <button className="text-link" onClick={() => go('markets')}>
                Post on Mezo (BTC, pTokens) <ArrowRight size={13} />
              </button>
              <button className="text-link" onClick={() => go('crosschain')}>
                Lock on a spoke (WETH, USDC) <ArrowRight size={13} />
              </button>
            </div>
          </div>

          <div className="leverage-selector market-switch">
            {(protocol?.markets ?? []).map((m) => (
              <button key={m.id} className={m.id === marketId ? 'is-selected' : ''} onClick={() => setMarketId(m.id)} aria-pressed={m.id === marketId}>
                {m.symbol}
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor="borrow-amount">
            BORROW AMOUNT{' '}
            <span>
              Available ≈ {market ? fmt(units(maxBorrow, market.decimals), 2) : '0'} {market?.symbol}
            </span>
          </label>
          <AmountInput
            id="borrow-amount"
            large
            value={amount}
            onChange={setAmount}
            unit={market?.symbol ?? ''}
            onMax={() => market && setAmount(toInput(maxBorrow, market.decimals))}
          />
          <div className="borrow-preview">
            <div>
              <span>Borrow APY</span>
              <b>{market ? fmtApy(perSecondToApy(market.borrowRatePerSecond)) : '—'}</b>
            </div>
            <div>
              <span>Health after</span>
              <b className={`tone-${healthStatus(hfAfter).tone}`}>{fmtHealth(hfAfter)}</b>
            </div>
            <div>
              <span>Your debt</span>
              <b>
                {market ? fmt(units(debt, market.decimals), 2) : '—'} {market?.symbol}
              </b>
            </div>
          </div>
          <ConnectGate connected={isConnected}>
            <div className="borrow-actions">
              <button className="button button--dark button--wide" onClick={borrow} disabled={invalid || Boolean(busy)}>
                {busy ?? (
                  <>
                    Borrow {market?.symbol} <ArrowRight size={15} />
                  </>
                )}
              </button>
              <button
                className="button button--light button--wide"
                onClick={() => market && openModal({ type: 'repay', marketId: market.id })}
                disabled={debt === 0n}
              >
                Repay <ArrowUpRight size={14} />
              </button>
            </div>
            {canRepayWithShares && sharePlan && market && shareCollateral && (
              <>
                <button
                  className="button button--outline button--wide repay-with-shares"
                  onClick={repayWithShares}
                  disabled={Boolean(busy) || sharePlan.blocked !== null}
                >
                  {busy ??
                    `Repay ${sharePlan.burnsAll ? '' : 'all '}${fmt(units(sharePlan.repaid, market.decimals), 2)} ${market.symbol} with posted ${shareCollateral.symbol} (no ${market.symbol} needed)`}
                </button>
                {sharePlan.blocked && <p className="action-blocked">{sharePlan.blocked}</p>}
              </>
            )}
          </ConnectGate>
          {blocked && <p className="action-blocked">{blocked}</p>}
          <PriceNotice unpriced={unpriced} relayError={relayError} unpricedDebts={unpricedDebts} />
          <div className="small-disclosure">
            <LockKeyhole size={14} /> MUSD/MEZO prices come from Pyth, pushed on Mezo. ETH/USDC prices are attached to the borrow as a signed Supra proof.
          </div>
        </section>

        <div className="borrow-side">
          <section className="panel risk-panel">
            <PanelTitle
              label="Position health"
              meta="Fresh-price valuation"
              action={
                <span className={`health-badge tone-${status.tone}`}>
                  <i /> {status.label}
                </span>
              }
            />
            <div className="health-overview">
              <div className="health-number">
                <span>HEALTH FACTOR</span>
                <strong className={`tone-${status.tone}`}>{fmtHealth(valued?.healthFactor ?? Infinity)}</strong>
                <em>Liquidatable below 1.00×</em>
              </div>
              <HealthGauge hf={valued?.healthFactor ?? Infinity} />
            </div>
            <div className="risk-meter">
              <div>
                <span>Current LTV</span>
                <b>{pct(valued?.ltv ?? 0)}</b>
              </div>
              <LtvMeter ltv={valued?.ltv ?? 0} maxLtv={maxLtv} liqLtv={liqLtv} hf={valued?.healthFactor ?? Infinity} />
            </div>
            <div className="risk-math">
              <span>
                Collateral value <b>{money(valued?.collateralUsd ?? 0)}</b>
              </span>
              <span>
                Borrow limit <b>{money(valued?.borrowLimitUsd ?? 0)}</b>
              </span>
              <span>
                Outstanding debt <b>{money(valued?.debtUsd ?? 0)}</b>
              </span>
              <span>
                Available <b className="positive-text">{money(valued?.availableUsd ?? 0)}</b>
              </span>
            </div>
          </section>
          <div className="panel vaultmanager-note">
            <span className="note-icon">
              <ShieldAlert size={17} />
            </span>
            <div>
              <b>One risk view, multiple chains.</b>
              <p>
                VaultManager sums every collateral — pTokens on Mezo and WETH/USDC on spokes — weighted by its LTV and liquidation threshold.{' '}
                {ltvMarks.length > 1 ? 'Limits shown are the blended thresholds of your collateral mix.' : ''}
              </p>
            </div>
          </div>
          <button className="panel link-panel" onClick={() => go('architecture')}>
            <span className="link-panel-icon">
              <Network size={17} />
            </span>
            <span>
              <b>How hub accounting works</b>
              <small>Contracts and message flow</small>
            </span>
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </>
  );
}
