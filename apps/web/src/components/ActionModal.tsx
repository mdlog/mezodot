import { useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Coins, Shield } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, maxWithdrawableUnits, perSecondToAnnual, symbolForPriceKey, type CollateralState, type MarketState } from '@mezodot/sdk';
import { HUB } from '../chain/env';
import { borrowSteps, postCollateralSteps, repaySteps, supplySteps, withdrawCollateralSteps, withdrawSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { useHubClient, useValuedPosition, useWalletBalances } from '../data/hooks';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { fmt, fmtApy, fmtHealth, money, units } from '../lib/format';
import { useUi, type AmountModal } from '../state/UiContext';
import { Modal } from './Modal';
import { AmountInput, ConnectGate } from './ui';

const TITLES: Record<AmountModal['type'], string> = {
  supply: 'Supply',
  withdraw: 'Withdraw',
  borrow: 'Borrow',
  repay: 'Repay',
  post: 'Use as collateral',
  unpost: 'Remove collateral',
};

/** Shares ⇄ underlying conversion through the pToken exchange rate (bigint, floor). */
const sharesFor = (m: MarketState, assets: bigint) => (assets * 10n ** BigInt(m.shareDecimals)) / (m.exchangeRate || 1n);
const assetsFor = (m: MarketState, shares: bigint) => (shares * m.exchangeRate) / 10n ** BigInt(m.shareDecimals);

export function ActionModal() {
  const { modal, closeModal } = useUi();
  if (!modal) return null;
  return (
    <Modal id="action-modal" overline="MEZODOT / MEZO HUB" title={TITLES[modal.type]} onClose={closeModal}>
      <ActionBody modal={modal} />
    </Modal>
  );
}

function ActionBody({ modal }: { modal: AmountModal }) {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { closeModal } = useUi();
  const { run, busy } = useTx();
  const { valued, protocol, prices, position } = useValuedPosition();
  const balances = useWalletBalances().data;
  const [amount, setAmount] = useState(modal.preset ?? '');
  const [useMax, setUseMax] = useState(false);

  const isCollateral = modal.type === 'post' || modal.type === 'unpost';
  const collateral: CollateralState | undefined = isCollateral ? protocol?.collaterals[modal.collateralId] : undefined;
  const market: MarketState | undefined = isCollateral
    ? protocol?.markets.find((m) => m.pool.toLowerCase() === collateral?.token.toLowerCase())
    : protocol?.markets[(modal as { marketId: number }).marketId];

  const info = useMemo(() => {
    if (!market || !protocol) return null;
    const symbol = symbolForPriceKey(market.priceKey);
    const price = symbol ? (prices?.[symbol] ?? 0) : 0;
    const walletAsset = balances?.hub.tokens[market.symbol] ?? 0n;
    const walletShares = balances?.hub.tokens[market.receiptSymbol] ?? 0n;
    const debt = position?.debts.find((x) => x.marketId === market.id)?.amount ?? 0n;
    const postedShares = collateral ? (position?.collateral.find((c) => c.id === collateral.id)?.balance ?? 0n) : 0n;
    const min = (a: bigint, b: bigint) => (a < b ? a : b);
    const walletShareAssets = assetsFor(market, walletShares);
    // Redeeming every share only works if the pool can pay them all; otherwise MAX is the pool's cash.
    const canRedeemAll = walletShares > 0n && walletShareAssets <= market.cash;
    // Removing collateral is limited by the debt it backs; with no debt all of it can go.
    const debtFree = !valued || valued.debtUsd <= 0;
    const unpostAll = debtFree;
    const unpostMax = unpostAll
      ? assetsFor(market, postedShares)
      : floorUnits(collateral && valued ? maxWithdrawableUnits(valued, collateral.id) : 0, market.decimals);
    const borrowMax = floorUnits(price > 0 ? ((valued?.availableUsd ?? 0) / price) * 0.999 : 0, market.decimals);

    // Max per action, in underlying base units (always exact bigints; never round-tripped through floats).
    const max: Record<AmountModal['type'], bigint> = {
      supply: walletAsset,
      withdraw: canRedeemAll ? walletShareAssets : min(walletShareAssets, market.cash),
      borrow: min(borrowMax, market.cash),
      repay: min(debt, walletAsset),
      post: walletShareAssets,
      unpost: min(unpostMax, assetsFor(market, postedShares)),
    };
    return { price, walletAsset, walletShares, debt, postedShares, canRedeemAll, unpostAll, max: max[modal.type] };
  }, [market, protocol, prices, balances, position, collateral, valued, modal.type]);

  if (!protocol || !market || !info) return <p className="muted-note">Loading on-chain data…</p>;

  const parsed = parseInput(amount, market.decimals);
  const value = parsed ?? 0n;
  const invalid = parsed === null || parsed > info.max;
  const usd = units(value, market.decimals) * info.price;

  // Health factor preview with fresh prices.
  const hfAfter = (() => {
    if (!valued) return null;
    let adjusted = valued.adjustedCollateralUsd;
    let debt = valued.debtUsd;
    if (modal.type === 'borrow') debt += usd;
    if (modal.type === 'repay') debt = Math.max(0, debt - usd);
    if (collateral && modal.type === 'post') adjusted += (usd * collateral.ltBps) / 10_000;
    if (collateral && modal.type === 'unpost') adjusted -= (usd * collateral.ltBps) / 10_000;
    return debt > 0 ? adjusted / debt : Infinity;
  })();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || !address || !hub) return;
    const ctx = { account: address, hub };
    const steps = (() => {
      switch (modal.type) {
        case 'supply':
          return supplySteps(ctx, market, value);
        case 'withdraw':
          return withdrawSteps(ctx, market, value, useMax && info.canRedeemAll ? { shares: info.walletShares } : null);
        case 'borrow':
          return borrowSteps(ctx, market, value);
        case 'repay':
          return repaySteps(ctx, market, useMax && info.debt <= info.walletAsset ? info.debt : value, useMax && info.debt <= info.walletAsset);
        case 'post':
          return postCollateralSteps(ctx, collateral!, useMax ? info.walletShares : sharesFor(market, value));
        case 'unpost':
          return withdrawCollateralSteps(ctx, collateral!, useMax && info.unpostAll ? info.postedShares : sharesFor(market, value));
      }
    })();
    const result = await run(`${TITLES[modal.type]} ${market.symbol}`, steps);
    if (result.ok) closeModal();
  };

  const rate =
    modal.type === 'borrow' || modal.type === 'repay' ? perSecondToAnnual(market.borrowRatePerSecond) : perSecondToAnnual(market.supplyRatePerSecond);
  const tone = hfAfter === null ? 'ok' : healthStatus(hfAfter).tone;

  return (
    <form onSubmit={submit}>
      <div className="modal-note">
        <Coins size={17} />
        <div>
          <b>
            {modal.type === 'supply' && `Deposit ${market.symbol}, receive ${market.receiptSymbol} (ERC-4626)`}
            {modal.type === 'withdraw' && `Redeem ${market.receiptSymbol} for ${market.symbol}`}
            {modal.type === 'borrow' && `Borrow ${market.symbol} on the Mezo Hub`}
            {modal.type === 'repay' && `Repay ${market.symbol} debt`}
            {modal.type === 'post' && `Escrow ${market.receiptSymbol} in VaultManager — it keeps earning`}
            {modal.type === 'unpost' && `Return ${market.receiptSymbol} from VaultManager to your wallet`}
          </b>
          <p>
            {modal.type === 'borrow' || modal.type === 'unpost'
              ? 'Fresh Pyth prices are posted with the transaction (small BTC fee).'
              : 'Approval is requested only if your allowance is too low.'}
          </p>
        </div>
      </div>
      <label className="field-label" htmlFor="modal-amount">
        AMOUNT{' '}
        <span>
          Max {fmt(units(info.max, market.decimals), 4)} {market.symbol}
        </span>
      </label>
      <AmountInput
        id="modal-amount"
        large
        autoFocus
        value={amount}
        onChange={(v) => {
          setAmount(v);
          setUseMax(false);
        }}
        unit={market.symbol}
        onMax={() => {
          setAmount(toInput(info.max, market.decimals));
          setUseMax(true);
        }}
      />
      <div className="modal-summary">
        <span>
          Value<b>{money(usd, 2)}</b>
        </span>
        <span>
          {modal.type === 'borrow' || modal.type === 'repay' ? 'Borrow APY' : 'Supply APY'}
          <b>{fmtApy(rate)}</b>
        </span>
        {modal.type === 'supply' && (
          <span>
            You receive
            <b>
              ≈ {fmt(units(sharesFor(market, value), market.shareDecimals), 4)} {market.receiptSymbol}
            </b>
          </span>
        )}
        {(modal.type === 'borrow' || modal.type === 'repay' || isCollateral) && valued && (
          <span>
            Health factor
            <b className={`tone-${tone}`}>
              {fmtHealth(valued.healthFactor)} → {hfAfter === null ? '—' : fmtHealth(hfAfter)}
            </b>
          </span>
        )}
      </div>
      {parsed !== null && parsed > info.max && (
        <p className="inline-error" role="alert">
          Amount exceeds the maximum available.
        </p>
      )}
      <div className="message-warning">
        <Shield size={14} /> Real transaction on {HUB.label}. Review it in your wallet before signing.
      </div>
      <ConnectGate connected={isConnected}>
        <button type="submit" disabled={invalid || Boolean(busy)} className="button button--dark button--wide">
          {busy ?? (
            <>
              {TITLES[modal.type]} {market.symbol} <ArrowRight size={14} />
            </>
          )}
        </button>
      </ConnectGate>
      {useMax && modal.type === 'repay' && info.debt > info.walletAsset && (
        <p className="muted-note">Wallet balance is below the full debt; repaying what you hold.</p>
      )}
    </form>
  );
}
