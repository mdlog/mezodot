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
import { borrowHeadroomUsd } from '../data/limits';
import { useHubClient, useValuedPosition } from '../data/hooks';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { fmt, fmtApy, fmtHealth, money, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import { PositionHealth } from './shared';

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
  const availableUnits = price > 0 ? borrowHeadroomUsd(valued) / price : 0;
  const liquidity = market ? units(market.cash, market.decimals) : 0;
  // Exact bigint limit: fresh-price headroom (floored, with the limit buffer) capped by pool cash and the borrow cap.
  const maxBorrow = market ? [floorUnits(availableUnits, market.decimals), market.cash, borrowRoom(market)].reduce((a, b) => (b < a ? b : a)) : 0n;
  const blocked = market ? borrowBlocked(market, flags) : null;

  const parsed = market ? parseInput(amount, market.decimals) : null;
  const value = parsed && market ? units(parsed, market.decimals) : 0;
  // VaultManager prices debt strictly: while a debt has no usable price every borrow reverts (PriceNotice says why).
  const invalid = parsed === null || parsed > maxBorrow || blocked !== null || unpricedDebts.length > 0;
  const hfAfter = valued ? (valued.debtUsd + value * price > 0 ? valued.adjustedCollateralUsd / (valued.debtUsd + value * price) : Infinity) : Infinity;
  const debt = market ? (position?.debts.find((d) => d.marketId === market.id)?.amount ?? 0n) : 0n;
  // Posted collateral, as one total here; Portfolio lists it asset by asset.
  const held = valued?.collateral.filter((c) => c.balance > 0n) ?? [];

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
        eyebrow="CAPITAL"
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
        time="Prices: Pyth on Mezo · Supra pull for ETH/USDC/BTC"
        icon={Shield}
      />
      {!HUB_DEPLOYED && <NotDeployed />}
      {HUB_DEPLOYED && !protocol && <HubPending what="your borrowing position" />}

      <div className="borrow-layout">
        <section className="panel borrow-form-panel">
          <PanelTitle label="Borrow" meta="Mezo Hub · MezodotPool" />
          <div className="borrow-from">
            <div>
              <span className="field-label">COLLATERAL</span>
              {valued && held.length > 0 && (
                <div className="collateral-detail">
                  <span className="collateral-logos" aria-hidden="true">
                    {held.map((c) => (
                      <TokenLogo key={c.collateral.id} symbol={c.collateral.symbol} network={spokeByWormholeChain(c.collateral.chainId)?.name} size={24} />
                    ))}
                  </span>
                  <span>
                    <b>{money(valued.collateralUsd)}</b>
                    <small>
                      across {held.length} asset{held.length === 1 ? '' : 's'}
                    </small>
                  </span>
                </div>
              )}
              {valued && held.length === 0 && <p className="muted-note">No collateral posted yet.</p>}
              {isConnected && (
                <button className="text-link collateral-breakdown" onClick={() => go('portfolio')}>
                  View in Portfolio <ArrowRight size={13} />
                </button>
              )}
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
            <LockKeyhole size={14} /> MUSD/MEZO prices come from Pyth, pushed on Mezo. ETH, USDC and BTC also have a Supra leg: a signed Supra proof goes along
            with the borrow whenever their stored price would not stay fresh until it lands.
          </div>
        </section>

        <div className="borrow-side">
          <PositionHealth valued={valued} />
          <div className="panel vaultmanager-note">
            <span className="note-icon">
              <ShieldAlert size={17} />
            </span>
            <div>
              <b>One risk view, multiple chains.</b>
              <p>
                VaultManager sums every collateral — pTokens on Mezo and WETH/USDC on spokes — weighted by its LTV and liquidation threshold.{' '}
                {held.length > 1 ? 'Limits shown are the blended thresholds of your collateral mix.' : ''}
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
