import { useState, type FormEvent } from 'react';
import { ArrowRight, Coins, Shield } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, maxWithdrawableUnits, symbolForPriceKey } from '@mezodot/sdk';
import { HUB } from '../chain/env';
import { postCollateralSteps, withdrawCollateralSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { postBlocked } from '../data/guards';
import { useHubClient, useValuedPosition, useWalletBalances } from '../data/hooks';
import { exactUnits, tightest, tokenPostBound, truncatedUnits } from '../data/limits';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { fmt, fmtHealth, money, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import { TokenLogo } from './Logos';
import { HubPending, QueryError } from './StatusBanners';
import { AmountInput, ConnectGate, PriceNotice } from './ui';

/**
 * Post or remove hub collateral that is a plain token (Mezo's BTC): amounts are token units, not pool shares,
 * and BTC spent here is also the gas token, so a reserve stays in the wallet.
 */
export function TokenCollateralBody({ type, collateralId, preset }: { type: 'post' | 'unpost'; collateralId: number; preset?: string }) {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { closeModal } = useUi();
  const { run, busy } = useTx();
  const { valued, protocol, prices, position, unpriced, unpricedDebts, debtFree, relayError } = useValuedPosition();
  const balancesQuery = useWalletBalances();
  const balances = balancesQuery.data;
  const [amount, setAmount] = useState(preset ?? '');

  const c = protocol?.collaterals[collateralId];
  if (!protocol || !c) return <HubPending />;
  // Posting is sized by the wallet: a failed balance read is unknown, never zero, so name it with a retry.
  if (type === 'post' && balances === undefined && balancesQuery.error) {
    return <QueryError error={balancesQuery.error} what="your wallet balances" onRetry={() => void balancesQuery.refetch()} />;
  }

  const symbol = symbolForPriceKey(c.priceKey);
  const price = symbol ? (prices?.[symbol] ?? 0) : 0;
  const held = balances?.hub.tokens[c.symbol] ?? 0n;
  const posted = position?.collateral.find((x) => x.id === c.id)?.balance ?? 0n;
  // New collateral waits while it is switched off or its cap is full (VaultManager._depositLocal).
  const reason = type === 'post' ? postBlocked(c) : null;
  // Removing collateral that backs debt needs prices: unknown until they load, and impossible while a debt has no
  // usable one (VaultManager prices debt strictly). With no debt (read from the position) all of it can go.
  const risked = type === 'unpost' && !debtFree;
  const blocked = reason !== null || (risked && unpricedDebts.length > 0);
  // Until the wallet (to post) and the position are read the max is unknown, not zero.
  const known = (type === 'unpost' || balances !== undefined) && position !== undefined && (!risked || valued !== null);
  const removable = debtFree ? posted : floorUnits(valued ? maxWithdrawableUnits(valued, c.id) : 0, c.decimals);
  // Posting: the wallet (less the gas reserve for BTC) within the collateral cap. Removing: what the position allows.
  const { max, limit } =
    type === 'post'
      ? tokenPostBound(c, held)
      : tightest({ max: posted, limit: `your posted ${c.symbol}` }, { max: removable, limit: 'what can be removed while your position stays healthy' });

  const parsed = parseInput(amount, c.decimals);
  const value = parsed ?? 0n;
  const invalid = parsed === null || !known || blocked || parsed > max;
  const usd = units(value, c.decimals) * price;
  const hfAfter = (() => {
    if (!valued) return null;
    const delta = (usd * c.ltBps) / 10_000;
    const adjusted = valued.adjustedCollateralUsd + (type === 'post' ? delta : -delta);
    return valued.debtUsd > 0 ? adjusted / valued.debtUsd : Infinity;
  })();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || !address || !hub) return;
    const ctx = { account: address, hub, protocol, position: position ?? null };
    const steps = type === 'post' ? postCollateralSteps(ctx, c, value) : withdrawCollateralSteps(ctx, c, value);
    const result = await run(`${type === 'post' ? 'Post' : 'Remove'} ${c.symbol} collateral`, steps);
    if (result.ok) closeModal();
  };

  return (
    <form onSubmit={submit}>
      <div className="modal-note">
        <Coins size={17} />
        <div>
          <b>{type === 'post' ? `Lock ${c.symbol} in VaultManager as collateral` : `Return ${c.symbol} from VaultManager to your wallet`}</b>
          <p>
            Borrow up to {c.ltvBps / 100}% of its value; liquidation starts at {c.ltBps / 100}%.{' '}
            {type === 'post' ? 'Approval is requested only if your allowance is too low.' : 'Prices the health check needs are attached automatically.'}
          </p>
        </div>
      </div>
      {risked && <PriceNotice unpriced={unpriced} relayError={relayError} unpricedDebts={unpricedDebts} />}
      {reason && (
        <p className="inline-error" role="status">
          {reason}
        </p>
      )}
      <label className="field-label" htmlFor="token-collateral-amount">
        AMOUNT{' '}
        <span>
          Max {known ? truncatedUnits(max, c.decimals, 6) : '…'} {c.symbol}
        </span>
      </label>
      <AmountInput
        id="token-collateral-amount"
        large
        autoFocus
        value={amount}
        onChange={setAmount}
        unit={c.symbol}
        onMax={() => known && setAmount(toInput(max, c.decimals))}
      />
      <div className="modal-summary">
        <span>
          Value<b>{money(usd, 2)}</b>
        </span>
        <span>
          Price<b>{money(price, 2)}</b>
        </span>
        {valued && (
          <span>
            Health factor
            <b className={`tone-${hfAfter === null ? 'ok' : healthStatus(hfAfter).tone}`}>
              {fmtHealth(valued.healthFactor)} → {hfAfter === null ? '—' : fmtHealth(hfAfter)}
            </b>
          </span>
        )}
        <span>
          <TokenLogo symbol={c.symbol} size={16} /> Posted<b>{fmt(units(posted, c.decimals), 6)}</b>
        </span>
      </div>
      {known && !blocked && parsed !== null && parsed > max && (
        <p className="inline-error" role="alert">
          Amount exceeds {limit}: at most {exactUnits(max, c.decimals)} {c.symbol}. Use MAX to fill it in.
        </p>
      )}
      <div className="message-warning">
        <Shield size={14} /> Real transaction on {HUB.label}. Review it in your wallet before signing.
      </div>
      <ConnectGate connected={isConnected}>
        <button type="submit" disabled={invalid || Boolean(busy)} title={reason ?? undefined} className="button button--dark button--wide">
          {busy ?? (
            <>
              {type === 'post' ? 'Post' : 'Remove'} {c.symbol} <ArrowRight size={14} />
            </>
          )}
        </button>
      </ConnectGate>
    </form>
  );
}
