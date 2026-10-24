import { useId, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { healthStatus, perSecondToApy } from '@mezodot/sdk';
import { ChainLogo, TokenLogo } from '../components/Logos';
import { SPOKES } from '../chain/env';
import { usePrices, useProtocol } from '../data/hooks';
import { fmt, fmtApy, fmtHealth, money } from '../lib/format';
import { simulateBorrow, spokeCollateral } from './simulate';

type Token = 'WETH' | 'USDC';

/** Slider range and starting amount per token. */
const AMOUNTS: Record<Token, { min: number; max: number; step: number; start: number; digits: number; priceSymbol: 'ETH' | 'USDC' }> = {
  WETH: { min: 0.05, max: 5, step: 0.05, start: 0.5, digits: 2, priceSymbol: 'ETH' },
  USDC: { min: 50, max: 10_000, step: 50, start: 1_000, digits: 0, priceSymbol: 'USDC' },
};

/**
 * What a deposit from a spoke could borrow on Mezo, before connecting anything: the hub's own loan-to-value and
 * liquidation threshold for that token and chain, at live prices.
 */
export function Simulator({ onOpen }: { onOpen: () => void }) {
  const protocol = useProtocol().data;
  const prices = usePrices().data?.prices;
  const spokes = SPOKES.filter((s) => s.deployment);
  const [spokeName, setSpokeName] = useState(spokes[0]?.name);
  const [token, setToken] = useState<Token>('WETH');
  const [amounts, setAmounts] = useState<Record<Token, number>>({ WETH: AMOUNTS.WETH.start, USDC: AMOUNTS.USDC.start });
  const [share, setShare] = useState(0.5);
  const amountId = useId();
  const shareId = useId();

  const spoke = spokes.find((s) => s.name === spokeName) ?? spokes[0];
  const range = AMOUNTS[token];
  const amount = amounts[token];
  const collateral = protocol && spoke ? spokeCollateral(protocol, spoke.wormholeChainId, token) : undefined;
  const price = prices?.[range.priceSymbol];
  const musdPrice = prices?.MUSD;
  const sim =
    collateral && price !== undefined && musdPrice !== undefined
      ? simulateBorrow({ amount, price, ltvBps: collateral.ltvBps, ltBps: collateral.ltBps, musdPrice, share })
      : null;
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const tone = sim ? healthStatus(sim.healthFactor).tone : 'ok';
  const note =
    !protocol || !prices ? 'Reading live prices from Mezo…' : !collateral ? `${token} is not accepted from ${spoke?.label ?? 'this chain'} yet.` : null;

  return (
    <section id="simulator" className="lp-simulator" aria-labelledby="lp-simulator-title">
      <div className="lp-container">
        <header className="lp-section-head">
          <h2 id="lp-simulator-title">What your collateral can do</h2>
          <p>Live prices and the loan-to-value the hub applies today. Nothing to connect.</p>
        </header>
        <div className="sim">
          <div className="sim-controls">
            <fieldset className="sim-choice">
              <legend>Chain</legend>
              {spokes.map((s) => (
                <button key={s.name} type="button" aria-pressed={s.name === spoke?.name} onClick={() => setSpokeName(s.name)}>
                  <ChainLogo network={s.name} size={20} />
                  {s.label}
                </button>
              ))}
            </fieldset>
            <fieldset className="sim-choice">
              <legend>Token</legend>
              {(['WETH', 'USDC'] as const).map((t) => (
                <button key={t} type="button" aria-pressed={t === token} onClick={() => setToken(t)}>
                  <TokenLogo symbol={t} size={20} />
                  {t}
                </button>
              ))}
            </fieldset>
            <div className="sim-slider">
              <label htmlFor={amountId}>
                Amount <output>{`${fmt(amount, range.digits)} ${token}`}</output>
              </label>
              <input
                id={amountId}
                type="range"
                min={range.min}
                max={range.max}
                step={range.step}
                value={amount}
                onChange={(e) => setAmounts((a) => ({ ...a, [token]: Number(e.target.value) }))}
              />
            </div>
            <div className="sim-slider">
              <label htmlFor={shareId}>
                Borrow <output>{`${Math.round(share * 100)}% of the limit`}</output>
              </label>
              <input id={shareId} type="range" min={0} max={1} step={0.05} value={share} onChange={(e) => setShare(Number(e.target.value))} />
            </div>
          </div>

          <div className="sim-readout" aria-live="polite">
            <dl>
              <div>
                <dt>Collateral</dt>
                <dd>{sim ? money(sim.valueUsd) : '—'}</dd>
              </div>
              <div>
                <dt>Borrow limit</dt>
                <dd>{sim ? `${fmt(sim.limitMusd, 0)} MUSD` : '—'}</dd>
              </div>
              <div>
                <dt>You borrow</dt>
                <dd>{sim ? `${fmt(sim.borrowMusd, 2)} MUSD` : '—'}</dd>
              </div>
              <div className={`sim-health tone-${tone}`}>
                <dt>Health factor</dt>
                <dd>{sim ? fmtHealth(sim.healthFactor) : '—'}</dd>
              </div>
              <div className="sim-wide">
                <dt>Liquidated if {range.priceSymbol} falls to</dt>
                <dd>{sim?.liquidationPrice != null ? money(sim.liquidationPrice, sim.liquidationPrice < 10 ? 2 : 0) : sim ? 'Never: no debt' : '—'}</dd>
              </div>
            </dl>
            {note && <p className="sim-note">{note}</p>}
            <p className="sim-fine">
              {collateral && `Loan-to-value ${collateral.ltvBps / 100}%, liquidation at ${collateral.ltBps / 100}%. `}
              {musd && `MUSD borrow rate now ${fmtApy(perSecondToApy(musd.borrowRatePerSecond))} a year. `}
              Collateral on the hub and other spokes adds to the same limit.
            </p>
            <button className="lp-button lp-button--primary" onClick={onOpen} disabled={!collateral}>
              Lock {token} on {spoke?.label ?? 'a spoke'} <ArrowUpRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
