import type { FormEvent } from 'react';
import { ArrowRight, Coins, Shield, Wallet, Waves } from 'lucide-react';
import { PRICES, PROTOCOL, RECEIPT_OF, RISK_PARAMS, chainOf, marketOf } from '../data/mock';
import { borrow, marketStats, repay, supply, withdraw } from '../lib/engine';
import { fmt, fmtHealth, money } from '../lib/format';
import { healthFactor, parseAmount, sharesForAssets } from '../lib/protocol';
import { useApp, type AmountAction, type ModalState } from '../state/AppContext';
import { Modal } from './Modal';
import { AmountInput } from './ui';

const TITLES: Record<ModalState['type'], string> = {
  supply: 'Supply',
  withdraw: 'Withdraw',
  borrow: 'Borrow MUSD',
  repay: 'Repay MUSD',
  bridge: 'Review collateral message',
  wallet: 'Connect demo wallet',
};

export function ActionModal() {
  const { modal, closeModal } = useApp();
  if (!modal) return null;
  const title = modal.type === 'supply' || modal.type === 'withdraw' ? `${TITLES[modal.type]} ${modal.asset}` : TITLES[modal.type];
  return (
    <Modal id="action-modal" overline="MEZODOT / DEMO ACTION" title={title} onClose={closeModal}>
      {modal.type === 'wallet' && <WalletBody />}
      {modal.type === 'bridge' && <BridgeBody {...modal} />}
      {modal.type !== 'wallet' && modal.type !== 'bridge' && <AmountBody {...modal} />}
    </Modal>
  );
}

function WalletBody() {
  const { connect } = useApp();
  return (
    <>
      <div className="modal-note">
        <Wallet size={17} />
        <div>
          <b>Demo wallet preview</b>
          <p>This UI does not request wallet permissions or connect to a provider. Continue to display a simulated account state.</p>
        </div>
      </div>
      <div className="modal-account">
        <span className="wallet-avatar">D</span>
        <span>
          <b>Demo account</b>
          <small>
            {PROTOCOL.demoAddress} · {PROTOCOL.network}
          </small>
        </span>
        <span className="mock-label">MOCK</span>
      </div>
      <button className="button button--dark button--wide" onClick={connect} data-autofocus>
        Use demo account <ArrowRight size={14} />
      </button>
    </>
  );
}

function BridgeBody({ chain, asset, amount }: Extract<ModalState, { type: 'bridge' }>) {
  const { startBridge } = useApp();
  const name = chainOf(chain).name;
  return (
    <>
      <div className="modal-note modal-note--bridge">
        <Waves size={17} />
        <div>
          <b>
            {asset} on {name} → Mezo Hub
          </b>
          <p>Principal remains on the external Spoke. A simulated collateral state message is applied to this local preview.</p>
        </div>
      </div>
      <div className="bridge-review">
        <span>
          Collateral amount{' '}
          <b>
            {fmt(amount, asset === 'wETH' ? 4 : 2)} {asset}
          </b>
        </span>
        <span>
          Estimated value <b>{money(amount * PRICES[asset], 2)}</b>
        </span>
        <span>
          Message fee <b>Illustrative</b>
        </span>
        <span>
          Network action <b>None · simulation only</b>
        </span>
      </div>
      <div className="message-warning">
        <Shield size={14} /> No token transfer, signature, or Wormhole transaction will occur.
      </div>
      <button className="button button--dark button--wide" onClick={() => startBridge({ chain, asset, amount })} data-autofocus>
        Confirm simulation <ArrowRight size={14} />
      </button>
    </>
  );
}

const NOTES: Record<AmountAction, string> = {
  supply: 'Estimate your receipt shares',
  withdraw: 'Return assets to your wallet',
  borrow: 'Borrow from the Mezo Hub',
  repay: 'Reduce outstanding debt',
};

const SUBMIT: Record<AmountAction, string> = {
  supply: 'Confirm supply',
  withdraw: 'Confirm withdrawal',
  borrow: 'Confirm borrow',
  repay: 'Confirm repayment',
};

function AmountBody({ type, asset, amount }: Extract<ModalState, { type: AmountAction }>) {
  const { state, summary, run, openModal, closeModal } = useApp();
  const { account, rates } = state;
  const receipt = RECEIPT_OF[asset];
  const setAmount = (value: string) => openModal({ type, asset, amount: value });
  const parsed = parseAmount(amount);
  const value = parsed ?? 0;

  const max = {
    supply: account.wallet[asset],
    withdraw: summary.earn[asset],
    borrow: Math.min(summary.available, marketStats('MUSD').liquidity),
    repay: Math.min(account.debtMUSD, account.wallet.MUSD),
  }[type];
  // Round MAX down to cents so the value never exceeds the limit after string conversion.
  const maxInput = Math.floor(max * 100) / 100;
  const invalid = parsed === null || parsed > max + 1e-9;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (parsed === null) return;
    const action = {
      supply: (s: typeof state) => supply(s, asset, parsed),
      withdraw: (s: typeof state) => withdraw(s, asset, parsed),
      borrow: (s: typeof state) => borrow(s, parsed),
      repay: (s: typeof state) => repay(s, parsed),
    }[type];
    if (run(action)) closeModal();
  };

  return (
    <form onSubmit={submit}>
      <div className="modal-note">
        <Coins size={17} />
        <div>
          <b>{NOTES[type]}</b>
          <p>Review the local demo values below. This will only update the preview state.</p>
        </div>
      </div>
      <label className="field-label" htmlFor="modal-amount">
        AMOUNT{' '}
        <span>
          Max {fmt(maxInput, 2)} {asset}
        </span>
      </label>
      <AmountInput
        id="modal-amount"
        large
        autoFocus
        value={amount}
        onChange={setAmount}
        unit={asset}
        max={maxInput}
        onMax={() => setAmount(String(maxInput))}
      />
      <div className="modal-summary">
        {type === 'supply' && (
          <>
            <span>
              Receipt estimate
              <b>
                {fmt(sharesForAssets(value, rates[receipt]), 2)} {receipt}
              </b>
            </span>
            <span>
              Simulated supply APY<b>{marketStats(asset).totalSupplyApy.toFixed(2)}%</b>
            </span>
          </>
        )}
        {type === 'withdraw' && (
          <>
            <span>
              Your supplied balance
              <b>
                {fmt(summary.earn[asset], 2)} {asset}
              </b>
            </span>
            <span>
              Shares redeemed
              <b>
                {fmt(sharesForAssets(value, rates[receipt]), 2)} {receipt}
              </b>
            </span>
          </>
        )}
        {type === 'borrow' && (
          <>
            <span>
              Available collateral capacity<b>{money(summary.available, 2)}</b>
            </span>
            <span>
              Borrow APY<b>{marketOf('MUSD').borrowApy.toFixed(2)}%</b>
            </span>
            <span>
              Health factor
              <b>
                {fmtHealth(summary.healthFactor)} → {fmtHealth(healthFactor(summary.collateral, summary.debt + value, RISK_PARAMS.liquidationThreshold))}
              </b>
            </span>
          </>
        )}
        {type === 'repay' && (
          <>
            <span>
              Outstanding Hub debt<b>{money(account.debtMUSD, 2)}</b>
            </span>
            <span>
              Remaining debt<b>{money(Math.max(0, account.debtMUSD - value), 2)}</b>
            </span>
            <span>
              Health factor
              <b>
                {fmtHealth(summary.healthFactor)} →{' '}
                {fmtHealth(healthFactor(summary.collateral, Math.max(0, summary.debt - value), RISK_PARAMS.liquidationThreshold))}
              </b>
            </span>
          </>
        )}
      </div>
      {parsed !== null && invalid && (
        <p className="inline-error" role="alert">
          Amount exceeds the maximum of {fmt(maxInput, 2)} {asset}.
        </p>
      )}
      <div className="message-warning">
        <Shield size={14} /> This is a local simulation. Nothing will be signed or sent.
      </div>
      <button type="submit" disabled={invalid} className="button button--dark button--wide">
        {SUBMIT[type]} <ArrowRight size={14} />
      </button>
    </form>
  );
}
