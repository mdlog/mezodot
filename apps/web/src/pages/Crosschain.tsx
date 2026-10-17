import { useState } from 'react';
import { ArrowDownLeft, ArrowRight, BadgeCheck, Check, LoaderCircle, Shield, Waves } from 'lucide-react';
import { AmountInput, DisclaimerBar, PageTitle, PanelTitle, SummaryStrip } from '../components/ui';
import { CHAINS, PRICES, chainOf, type ChainId, type CollateralAsset } from '../data/mock';
import { validateCollateral } from '../lib/engine';
import { fmt, money } from '../lib/format';
import { parseAmount } from '../lib/protocol';
import { BRIDGE_STEPS, useApp } from '../state/AppContext';

const ASSETS: CollateralAsset[] = ['wETH', 'USDC'];

export function Crosschain() {
  const { state, summary, go, openModal, showToast, bridgeStage, bridgeFlight } = useApp();
  const [chainId, setChainId] = useState<ChainId>('arbitrum');
  const [asset, setAsset] = useState<CollateralAsset>('wETH');
  const [amount, setAmount] = useState('0.5');

  const chain = chainOf(chainId);
  const balance = state.account.spokeWallet[chainId][asset];
  const parsed = parseAmount(amount);
  const chainCollateral = summary.remoteByChain.find((c) => c.chain.id === chainId)!;
  // While a message is in flight the lifecycle follows that message's chain, not the current form selection.
  const lifecycleChain = bridgeFlight ? chainOf(bridgeFlight.chain) : chain;
  const inFlight = bridgeFlight !== null;

  const review = () => {
    const value = parsed ?? 0;
    const error = validateCollateral(state, chainId, asset, value);
    if (error) return showToast(error, 'error');
    openModal({ type: 'bridge', chain: chainId, asset, amount: value });
  };

  const steps = [
    { title: 'Collateral locked on Spoke', where: `${lifecycleChain.name} · SpokeGateway` },
    { title: 'Wormhole message published', where: 'WormholeAdapter' },
    { title: 'VaultManager state updated', where: 'Mezo Hub · VaultManager' },
    { title: 'MUSD capacity available', where: 'Borrow MUSD on Mezo' },
  ];

  return (
    <>
      <PageTitle
        eyebrow="CAPITAL / 02"
        title="Collateral, without the detour."
        subtitle="Keep assets on an external Spoke. Send verified state to the Mezo Hub and borrow where the liquidity lives."
        right={
          <button className="button button--outline" onClick={() => go('borrow')}>
            <ArrowDownLeft size={15} /> Borrow MUSD
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            HUB & SPOKE <i>/</i> WORMHOLE MESSAGING MODEL
          </>
        }
        time="Message route simulated"
        icon={Waves}
      />

      <div className="cross-layout">
        <section className="panel bridge-config">
          <PanelTitle label="Post cross-chain collateral" meta="SpokeGateway / mock flow" />
          <div className="form-section">
            <span className="field-label">01 / SOURCE CHAIN</span>
            <div className="chain-options">
              {CHAINS.map((item) => {
                const selected = chainId === item.id;
                return (
                  <button key={item.id} className={`chain-option ${selected ? 'is-selected' : ''}`} onClick={() => setChainId(item.id)} aria-pressed={selected}>
                    <span className="chain-disc" style={{ background: item.color }}>
                      {item.short}
                    </span>
                    <span>
                      <b>{item.name}</b>
                      <small>{selected ? 'Selected · simulated' : 'Connected · simulated'}</small>
                    </span>
                    {selected && <Check size={16} />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="form-section">
            <span className="field-label">02 / COLLATERAL ASSET</span>
            <div className="asset-select-row">
              {ASSETS.map((item) => (
                <button
                  key={item}
                  className={`asset-choice ${asset === item ? 'is-selected' : ''}`}
                  onClick={() => setAsset(item)}
                  aria-pressed={asset === item}
                >
                  <span className={`coin-mini ${item === 'wETH' ? 'coin-eth' : 'coin-usdc'}`}>{item === 'wETH' ? 'Ξ' : '$'}</span>
                  <b>{item}</b>
                  <span>{money(PRICES[item], 2)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="form-section">
            <label className="field-label" htmlFor="bridge-amount">
              03 / AMOUNT{' '}
              <span>
                {chain.name} balance · {fmt(balance, asset === 'wETH' ? 4 : 2)} {asset}
              </span>
            </label>
            <AmountInput id="bridge-amount" value={amount} onChange={setAmount} unit={asset} onMax={() => setAmount(String(balance))} />
            <div className="amount-estimate">
              Estimated value <b>{money((parsed ?? 0) * PRICES[asset], 2)}</b>
            </div>
          </div>
          <button className="button button--dark button--wide" onClick={review} disabled={inFlight}>
            {inFlight ? (
              <>
                <LoaderCircle size={15} className="spin" /> Message in flight…
              </>
            ) : (
              <>
                Review simulated deposit <ArrowRight size={15} />
              </>
            )}
          </button>
          <div className="small-disclosure">
            <Shield size={14} /> Demo only. No wallet, bridge, or cross-chain message is connected.
          </div>
        </section>

        <div className="bridge-side">
          <section className="panel route-panel">
            <PanelTitle label="Capital route" meta="External Spoke → Mezo Hub" />
            <div className="route-visual">
              <div className="route-endpoint">
                <div className="route-orb" style={{ background: chain.color }}>
                  <span>{chain.short}</span>
                </div>
                <b>{chain.name}</b>
                <small>Spoke Gateway</small>
                <em>{money(chainCollateral.usd)} posted here</em>
              </div>
              <div className="route-track">
                <div className="track-line">
                  <span className="track-pulse" />
                </div>
                <div className="route-protocol">
                  <Waves size={16} />
                  <b>WormholeAdapter</b>
                  <small>message · verify · relay</small>
                </div>
                <div className="track-line">
                  <span className="track-pulse track-pulse--right" />
                </div>
              </div>
              <div className="route-endpoint">
                <div className="route-orb orb-mezo">
                  <span>M</span>
                </div>
                <b>Mezo</b>
                <small>VaultManager</small>
                <em>{money(summary.remoteCollateral)} total Spoke collateral</em>
              </div>
            </div>
            <div className="route-note">
              <span className="info-mark">i</span>
              <p>
                <b>Collateral stays on {chain.name}.</b> The Hub receives a verified state message, not the underlying principal. Borrowing and accounting
                happen on Mezo.
              </p>
            </div>
          </section>

          <section className="panel timeline-panel">
            <PanelTitle label="Message lifecycle" meta={inFlight ? 'IN FLIGHT · SIMULATED' : 'SIMULATED'} />
            <ol className="message-steps" aria-live="polite">
              {steps.map((step, index) => {
                const done = bridgeStage > index && !(inFlight && bridgeStage === index + 1);
                const current = inFlight && bridgeStage === index + 1;
                return (
                  <li className={`message-step ${done ? 'step-done' : ''} ${current ? 'step-current' : ''}`} key={step.title}>
                    <span>{done ? <Check size={11} /> : current ? <LoaderCircle size={11} className="spin" /> : `0${index + 1}`}</span>
                    <div>
                      <b>{step.title}</b>
                      <small>{step.where}</small>
                    </div>
                    {done && <BadgeCheck size={14} />}
                  </li>
                );
              })}
            </ol>
            {!inFlight && bridgeStage >= BRIDGE_STEPS && <p className="lifecycle-done">Last message delivered · capacity {money(summary.available, 2)} MUSD</p>}
            <button className="text-link" onClick={() => go('architecture')}>
              View architecture <ArrowRight size={13} />
            </button>
          </section>
        </div>
      </div>

      <DisclaimerBar title="Cross-chain flow is a product simulation." action="Recent messages" onAction={() => go('activity')}>
        Wormhole messaging and SpokeGateway actions are not connected to a live network.
      </DisclaimerBar>
    </>
  );
}
