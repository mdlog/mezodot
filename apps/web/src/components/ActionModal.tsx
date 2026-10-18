import { useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Coins, Shield } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, maxWithdrawableUnits, perSecondToApy, symbolForPriceKey, type CollateralState, type MarketState } from '@mezodot/sdk';
import { HUB } from '../chain/env';
import { borrowSteps, postCollateralSteps, repaySteps, supplySteps, withdrawCollateralSteps, withdrawSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { borrowBlocked, postBlocked, supplyBlocked, useHubFlags } from '../data/guards';
import { useHubClient, useProtocol, useValuedPosition, useWalletBalances } from '../data/hooks';
import { borrowBound, exactUnits, sharePostBound, supplyBound, tightest, truncatedUnits, type Bound } from '../data/limits';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { fmt, fmtApy, fmtHealth, money, units } from '../lib/format';
import { assetsFor, sharesFor } from '../lib/shares';
import { useUi, type AmountModal } from '../state/UiContext';
import { Modal } from './Modal';
import { HubPending, QueryError } from './StatusBanners';
import { AmountInput, ConnectGate, PriceNotice } from './ui';
import { TokenCollateralBody } from './TokenCollateralBody';

const TITLES: Record<AmountModal['type'], string> = {
  supply: 'Supply',
  withdraw: 'Withdraw',
  borrow: 'Borrow',
  repay: 'Repay',
  post: 'Use as collateral',
  unpost: 'Remove collateral',
};

export function ActionModal() {
  const { modal, closeModal } = useUi();
  const protocol = useProtocol().data;
  if (!modal) return null;
  // Plain hub collateral (BTC) is posted in token units, without a pool behind it.
  const plain = (modal.type === 'post' || modal.type === 'unpost') && protocol?.collaterals[modal.collateralId]?.isShare === false;
  return (
    <Modal id="action-modal" overline="MEZODOT / MEZO HUB" title={TITLES[modal.type]} onClose={closeModal}>
      {plain && (modal.type === 'post' || modal.type === 'unpost') ? (
        <TokenCollateralBody type={modal.type} collateralId={modal.collateralId} preset={modal.preset} />
      ) : (
        <ActionBody modal={modal} />
      )}
    </Modal>
  );
}

function ActionBody({ modal }: { modal: AmountModal }) {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { closeModal } = useUi();
  const { run, busy } = useTx();
  const { valued, protocol, prices, position, unpriced, unpricedDebts, debtFree, relayError } = useValuedPosition();
  const balancesQuery = useWalletBalances();
  const balances = balancesQuery.data;
  const flags = useHubFlags().data;
  const [amount, setAmount] = useState(modal.preset ?? '');
  const [useMax, setUseMax] = useState(false);
  // The shares a MAX post sends, fixed when MAX is clicked: the room under the cap may change before submitting.
  const [maxShares, setMaxShares] = useState<bigint | null>(null);

  const isCollateral = modal.type === 'post' || modal.type === 'unpost';
  // Borrowing and removing collateral are sized by the position alone; every other action by what the wallet holds.
  const needsWallet = modal.type !== 'borrow' && modal.type !== 'unpost';
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
    const walletShareAssets = assetsFor(market, walletShares);
    const shareBalance: Bound = { max: walletShareAssets, limit: `your ${market.receiptSymbol} balance` };
    // Redeeming every share only works if the pool can pay them all; otherwise MAX is the pool's cash.
    const canRedeemAll = walletShares > 0n && walletShareAssets <= market.cash;
    // Removing collateral is limited by the debt it backs; with no debt (read from the position, not from
    // prices) all of it can go.
    const unpostAll = debtFree;
    const unpostMax = unpostAll
      ? assetsFor(market, postedShares)
      : floorUnits(collateral && valued ? maxWithdrawableUnits(valued, collateral.id) : 0, market.decimals);
    const headroom = floorUnits(price > 0 ? ((valued?.availableUsd ?? 0) / price) * 0.999 : 0, market.decimals);
    // Posting is also capped by the room left under the collateral cap (in shares); MAX then posts exactly that.
    const post = collateral ? sharePostBound(market, collateral, walletShares) : { ...shareBalance, shares: walletShares };

    // Max per action, in underlying base units (always exact bigints; never round-tripped through floats), with what
    // sets it for the message shown when an amount goes over it. Supply, borrow and post stop at the caps too.
    const bounds: Record<AmountModal['type'], Bound> = {
      supply: supplyBound(market, walletAsset),
      withdraw: tightest(shareBalance, { max: market.cash, limit: "the pool's available liquidity" }),
      borrow: borrowBound(market, headroom),
      repay: tightest({ max: debt, limit: 'your outstanding debt' }, { max: walletAsset, limit: `your ${market.symbol} wallet balance` }),
      post,
      unpost: tightest(
        { max: assetsFor(market, postedShares), limit: `your posted ${market.receiptSymbol}` },
        { max: unpostMax, limit: 'what can be removed while your position stays healthy' },
      ),
    };
    // Pauses, switches and full caps the contracts enforce: the action waits with the reason instead of reverting
    // after the wallet prompt. Unknown flags block nothing (the contract still decides).
    const reason =
      modal.type === 'supply'
        ? supplyBlocked(market, flags)
        : modal.type === 'borrow'
          ? borrowBlocked(market, flags)
          : modal.type === 'post' && collateral
            ? postBlocked(collateral)
            : null;
    // Until the reads an action is sized by land its max is unknown, not zero; so is a limit that needs prices
    // (borrowing, or removing collateral that backs debt) until they load.
    const risked = modal.type === 'borrow' || (modal.type === 'unpost' && !debtFree);
    const known = (!needsWallet || balances !== undefined) && position !== undefined && (!risked || valued !== null);
    // VaultManager prices debt strictly: with a debt unpriced the call reverts (PriceNotice says why), and a borrow
    // also needs a price for the asset it borrows.
    const debtUnpriced = risked && unpricedDebts.length > 0;
    const noBorrowPrice = modal.type === 'borrow' && known && reason === null && !debtUnpriced && price <= 0;
    return {
      price,
      walletAsset,
      walletShares,
      debt,
      postedShares,
      postShares: post.shares,
      canRedeemAll,
      unpostAll,
      max: bounds[modal.type].max,
      limit: bounds[modal.type].limit,
      known,
      reason,
      noBorrowPrice,
      blocked: reason !== null || debtUnpriced || noBorrowPrice,
    };
  }, [market, protocol, prices, balances, position, collateral, valued, debtFree, unpricedDebts, flags, needsWallet, modal.type]);

  if (!protocol || !market || !info) return <HubPending />;
  // A failed balance read is unknown, never zero: name it with a retry instead of a max that never loads.
  if (needsWallet && balances === undefined && balancesQuery.error) {
    return <QueryError error={balancesQuery.error} what="your wallet balances" onRetry={() => void balancesQuery.refetch()} />;
  }

  const parsed = parseInput(amount, market.decimals);
  const value = parsed ?? 0n;
  const invalid = parsed === null || !info.known || info.blocked || parsed > info.max;
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
    const ctx = { account: address, hub, protocol, position: position ?? null };
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
          return postCollateralSteps(ctx, collateral!, useMax && maxShares !== null ? maxShares : sharesFor(market, value));
        case 'unpost':
          return withdrawCollateralSteps(ctx, collateral!, useMax && info.unpostAll ? info.postedShares : sharesFor(market, value));
      }
    })();
    const result = await run(`${TITLES[modal.type]} ${market.symbol}`, steps);
    if (result.ok) closeModal();
  };

  const rate = modal.type === 'borrow' || modal.type === 'repay' ? perSecondToApy(market.borrowRatePerSecond) : perSecondToApy(market.supplyRatePerSecond);
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
              ? 'Prices the health check needs are attached when they are about to expire (Supra proofs from the Mezodot agent).'
              : 'Approval is requested only if your allowance is too low.'}
          </p>
        </div>
      </div>
      {(modal.type === 'borrow' || (modal.type === 'unpost' && !debtFree)) && (
        <PriceNotice unpriced={unpriced} relayError={relayError} unpricedDebts={unpricedDebts} />
      )}
      {info.reason && (
        <p className="inline-error" role="status">
          {info.reason}
        </p>
      )}
      {info.noBorrowPrice && (
        <p className="inline-error" role="status">
          No usable {market.symbol} price right now: a borrow is priced strictly and would revert until a fresh price is posted.
        </p>
      )}
      <label className="field-label" htmlFor="modal-amount">
        AMOUNT{' '}
        <span>
          Max {info.known ? truncatedUnits(info.max, market.decimals, 4) : '…'} {market.symbol}
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
          setMaxShares(null);
        }}
        unit={market.symbol}
        onMax={() => {
          if (!info.known) return;
          setAmount(toInput(info.max, market.decimals));
          setUseMax(true);
          setMaxShares(info.postShares);
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
      {info.known && !info.blocked && parsed !== null && parsed > info.max && (
        <p className="inline-error" role="alert">
          Amount exceeds {info.limit}: at most {exactUnits(info.max, market.decimals)} {market.symbol}. Use MAX to fill it in.
        </p>
      )}
      <div className="message-warning">
        <Shield size={14} /> Real transaction on {HUB.label}. Review it in your wallet before signing.
      </div>
      <ConnectGate connected={isConnected}>
        <button type="submit" disabled={invalid || Boolean(busy)} title={info.reason ?? undefined} className="button button--dark button--wide">
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
