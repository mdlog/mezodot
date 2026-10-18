import { useState, type FormEvent } from 'react';
import { ArrowRight, Coins, Shield } from 'lucide-react';
import { useAccount } from 'wagmi';
import { healthStatus, maxWithdrawableUnits, symbolForPriceKey } from '@mezodot/sdk';
import { HUB } from '../chain/env';
import { postCollateralSteps, withdrawCollateralSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { useHubClient, useValuedPosition, useWalletBalances } from '../data/hooks';
import { BTC_GAS_RESERVE, isGasToken, spendableBtc } from '../lib/btc';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { fmt, fmtHealth, money, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import { TokenLogo } from './Logos';
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
  const { valued, protocol, prices, position, unpriced, relayError } = useValuedPosition();
  const balances = useWalletBalances().data;
  const [amount, setAmount] = useState(preset ?? '');

  const c = protocol?.collaterals[collateralId];
  if (!protocol || !c) return <p className="muted-note">Loading on-chain data…</p>;

  const symbol = symbolForPriceKey(c.priceKey);
  const price = symbol ? (prices?.[symbol] ?? 0) : 0;
  const gas = isGasToken(c.token);
  const held = balances?.hub.tokens[c.symbol] ?? 0n;
  const posted = position?.collateral.find((x) => x.id === c.id)?.balance ?? 0n;
  const debtFree = !valued || valued.debtUsd <= 0;
  // Until the wallet and position are read the max is unknown, not zero.
  const known = balances !== undefined && position !== undefined;
  const removable = debtFree ? posted : floorUnits(valued ? maxWithdrawableUnits(valued, c.id) : 0, c.decimals);
  const max = type === 'post' ? (gas ? spendableBtc(held) : held) : removable < posted ? removable : posted;
  const limit =
    type === 'post'
      ? `your ${c.symbol} wallet balance${gas ? ` (keeping ${fmt(units(BTC_GAS_RESERVE, 18), 4)} BTC for gas)` : ''}`
      : debtFree
        ? `your posted ${c.symbol}`
        : 'what can be removed while your position stays healthy';

  const parsed = parseInput(amount, c.decimals);
  const value = parsed ?? 0n;
  const invalid = parsed === null || !known || parsed > max;
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
      {type === 'unpost' && <PriceNotice unpriced={unpriced} relayError={relayError} />}
      <label className="field-label" htmlFor="token-collateral-amount">
        AMOUNT{' '}
        <span>
          Max {known ? fmt(units(max, c.decimals), 6) : '…'} {c.symbol}
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
      {known && parsed !== null && parsed > max && (
        <p className="inline-error" role="alert">
          Amount exceeds {limit}: at most {fmt(units(max, c.decimals), 6)} {c.symbol}. Use MAX to fill it in.
        </p>
      )}
      <div className="message-warning">
        <Shield size={14} /> Real transaction on {HUB.label}. Review it in your wallet before signing.
      </div>
      <ConnectGate connected={isConnected}>
        <button type="submit" disabled={invalid || Boolean(busy)} className="button button--dark button--wide">
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
