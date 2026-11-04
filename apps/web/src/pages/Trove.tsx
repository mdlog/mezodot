import { useState } from 'react';
import { ArrowRight, Landmark, LockKeyhole, ShieldAlert } from 'lucide-react';
import { useAccount, useSignTypedData } from 'wagmi';
import { formatUnits } from 'viem';
import {
  MIN_NET_DEBT,
  closeBlockedReason,
  TROVE_STATUS,
  maxTroveRepay,
  openBlockers,
  perSecondToApy,
  previewOpenTrove,
  readTrove,
  troveContracts,
  type TroveState,
} from '@mezodot/sdk';
import { AmountInput, ConnectGate, NotDeployed, PageTitle, PanelTitle, SummaryStrip } from '../components/ui';
import { HUB, HUB_DEPLOYED } from '../chain/env';
import { useTx } from '../chain/tx';
import { claimTroveSurplusSteps, closeTroveSteps, openTroveSteps, repayTroveSteps, type TroveSigner } from '../chain/trove';
import { useHubClient, useProtocol, useTrove } from '../data/hooks';
import { closePlan, type TroveWallet } from '../data/trove';
import { parseInput, toInput } from '../lib/amount';
import { fmt, fmtApy, money, units } from '../lib/format';

const pct = (ratio: bigint) => `${Number(formatUnits(ratio, 16)).toFixed(1)}%`;
const musd = (v: bigint) => `${fmt(units(v, 18), 2)} MUSD`;
const btc = (v: bigint) => `${fmt(units(v, 18), 4)} BTC`;

function SystemPanel({ trove, supplyApy }: { trove: TroveState | undefined; supplyApy: number | null }) {
  return (
    <div className="panel trove-system">
      <PanelTitle label="Mezo system" meta="Live" />
      <div className="borrow-preview">
        <div>
          <span>System ratio</span>
          <b>{trove ? pct(trove.tcr) : '—'}</b>
        </div>
        <div>
          <span>Recovery Mode</span>
          <b className={trove?.recoveryMode ? 'tone-danger' : undefined}>{trove ? (trove.recoveryMode ? 'Active' : 'Off') : '—'}</b>
        </div>
        <div>
          <span>Borrowing fee</span>
          <b>{trove ? pct(trove.borrowingRate) : '—'}</b>
        </div>
        <div>
          <span>Trove interest</span>
          <b>{trove ? `${(trove.interestRateBps / 100).toFixed(2)}%` : '—'}</b>
        </div>
        <div>
          <span>pMUSD supply APY</span>
          <b>{supplyApy === null ? '—' : fmtApy(supplyApy)}</b>
        </div>
      </div>
    </div>
  );
}

function RiskNote() {
  return (
    <div className="panel vaultmanager-note">
      <span className="note-icon">
        <ShieldAlert size={17} />
      </span>
      <div>
        <b>What can happen to a trove.</b>
        <p>
          Below 110% it can be liquidated, and in Recovery Mode the line moves up to 150%. Anyone holding MUSD can also redeem it for BTC at face value,
          starting with the lowest-ratio troves: that shrinks your debt and your BTC together, and a trove redeemed in full closes, with any BTC left waiting
          here for you to claim. Mezodot has no control over any of these.
        </p>
      </div>
    </div>
  );
}

function OpenForm({ wallet, sign, connected }: { wallet: TroveWallet | undefined; sign: TroveSigner; connected: boolean }) {
  const { address } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const [btcInput, setBtcInput] = useState('');
  const [debtInput, setDebtInput] = useState('2000');
  const [post, setPost] = useState(false);

  const trove = wallet?.trove;
  const btcAmount = parseInput(btcInput, 18);
  const debtAmount = parseInput(debtInput, 18);
  const input =
    trove && btcAmount && debtAmount
      ? { btc: btcAmount, debtAmount, price: trove.price, borrowingRate: trove.borrowingRate, recoveryMode: trove.recoveryMode }
      : null;
  const preview = input ? previewOpenTrove(input) : null;
  const blockers =
    input && trove
      ? openBlockers({ ...input, systemColl: trove.systemColl, systemDebt: trove.systemDebt, status: trove.status, isContract: trove.isContract })
      : [];
  const short = Boolean(address && wallet && btcAmount && btcAmount > wallet.btc);

  const open = async () => {
    if (!address || !hub || !btcAmount || !debtAmount) return;
    const result = await run(
      'Open a trove',
      openTroveSteps({ account: address, hub }, { btc: btcAmount, debtAmount, post }, () => readTrove(hub, HUB.deployment!, address), sign),
    );
    if (result.ok) setBtcInput('');
  };

  return (
    <section className="panel borrow-form-panel trove-form">
      <PanelTitle label="Open and supply" meta="One transaction" />
      <label className="field-label" htmlFor="trove-btc">
        BTC COLLATERAL <span>Wallet {address && wallet ? btc(wallet.btc) : '—'}</span>
      </label>
      <AmountInput
        id="trove-btc"
        large
        value={btcInput}
        onChange={setBtcInput}
        unit="BTC"
        onMax={() => address && wallet && setBtcInput(toInput(wallet.btc, 18))}
      />
      <label className="field-label" htmlFor="trove-debt">
        MUSD TO MINT AND SUPPLY <span>Minimum {fmt(units(MIN_NET_DEBT, 18), 0)}, fee included</span>
      </label>
      <AmountInput id="trove-debt" large value={debtInput} onChange={setDebtInput} unit="MUSD" />
      <div className="borrow-preview">
        <div>
          <span>Borrowing fee</span>
          <b>{preview ? musd(preview.fee) : '—'}</b>
        </div>
        <div>
          <span>Trove debt</span>
          <b>{preview ? musd(preview.totalDebt) : '—'}</b>
        </div>
        <div>
          <span>Collateral ratio</span>
          <b>{preview ? pct(preview.icr) : '—'}</b>
        </div>
        <div>
          <span>Liquidation price</span>
          <b>{preview ? money(units(preview.liquidationPrice, 18)) : '—'}</b>
        </div>
      </div>
      <p className="trove-explain">
        Trove debt includes 200 MUSD of gas compensation that comes back when you close. You only receive pMUSD for the MUSD minted, so a close needs a little
        MUSD on top.
      </p>
      <label className="trove-check">
        <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} /> Post the pMUSD as Mezodot collateral
      </label>
      <ConnectGate connected={connected}>
        <button className="button button--dark button--wide" onClick={open} disabled={!preview || blockers.length > 0 || short || Boolean(busy)}>
          {busy ?? (
            <>
              Sign and open <ArrowRight size={15} />
            </>
          )}
        </button>
      </ConnectGate>
      {short && <p className="action-blocked">This wallet holds less BTC than that.</p>}
      {blockers.map((b) => (
        <p className="action-blocked" key={b}>
          {b}
        </p>
      ))}
      <div className="small-disclosure">
        <LockKeyhole size={14} /> Your wallet signs Mezo&apos;s own typed message naming the amounts and this router. Mezo checks plain ECDSA signatures, so
        this needs an EOA wallet, not a smart account.
      </div>
    </section>
  );
}

function ActiveTrove({ wallet, sign }: { wallet: TroveWallet; sign: TroveSigner }) {
  const { address } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const [repayInput, setRepayInput] = useState('');
  const { trove } = wallet;

  const repayable = [maxTroveRepay(trove.debt), wallet.supplyAssets].reduce((a, b) => (b < a ? b : a));
  const amount = parseInput(repayInput, 18);
  const repayInvalid = amount === null || amount === 0n || amount > repayable;
  const plan = closePlan({ debt: trove.debt, shares: wallet.shares, supplyAssets: wallet.supplyAssets, walletMusd: wallet.musd });
  const blocked = closeBlockedReason(trove);
  const fresh = () => readTrove(hub!, HUB.deployment!, address!);

  const repay = async () => {
    if (!address || !hub || !amount) return;
    const result = await run('Repay trove', repayTroveSteps({ account: address, hub }, { amount }, fresh, sign));
    if (result.ok) setRepayInput('');
  };
  const close = async () => {
    if (!address || !hub) return;
    await run('Close trove', closeTroveSteps({ account: address, hub }, { shares: plan.shares, fromWallet: plan.fromWallet }, fresh, sign));
  };

  return (
    <section className="panel borrow-form-panel trove-form">
      <PanelTitle label="Your trove" meta={HUB.label} />
      <div className="borrow-preview">
        <div>
          <span>Collateral</span>
          <b>{btc(trove.coll)}</b>
        </div>
        <div>
          <span>Debt</span>
          <b>{musd(trove.debt)}</b>
        </div>
        <div>
          <span>Collateral ratio</span>
          <b>{pct(trove.icr)}</b>
        </div>
        <div>
          <span>pMUSD supply</span>
          <b>{musd(wallet.supplyAssets)}</b>
        </div>
      </div>
      <label className="field-label" htmlFor="trove-repay">
        REPAY FROM SUPPLY <span>Up to {musd(repayable)}</span>
      </label>
      <AmountInput id="trove-repay" large value={repayInput} onChange={setRepayInput} unit="MUSD" onMax={() => setRepayInput(toInput(repayable, 18))} />
      <button className="button button--light button--wide" onClick={repay} disabled={repayInvalid || Boolean(busy)}>
        {busy ?? 'Sign and repay'}
      </button>
      <p className="trove-explain">
        Mezo keeps at least {fmt(units(MIN_NET_DEBT, 18), 0)} MUSD of debt on an open trove. Closing burns {musd(plan.needed)}: {musd(plan.fromSupply)} from
        pMUSD
        {plan.fromWallet > 0n ? ` and ${musd(plan.fromWallet)} from your wallet` : ''}. {btc(trove.coll)} comes back to this wallet.
      </p>
      <button className="button button--dark button--wide" onClick={close} disabled={plan.shortfall > 0n || blocked !== null || Boolean(busy)}>
        {busy ?? 'Sign and close trove'}
      </button>
      {plan.shortfall > 0n && (
        <p className="action-blocked">You are {musd(plan.shortfall)} short. Posted pMUSD must be withdrawn from Portfolio to count here.</p>
      )}
      {blocked && <p className="action-blocked">{blocked}</p>}
    </section>
  );
}

function ClosedTrove({ status }: { status: number }) {
  if (status === TROVE_STATUS.CLOSED_BY_REDEMPTION) return <p className="trove-explain">Your last trove was redeemed in full. You kept the MUSD it minted.</p>;
  if (status === TROVE_STATUS.CLOSED_BY_LIQUIDATION) return <p className="trove-explain">Your last trove was liquidated. You kept the MUSD it minted.</p>;
  return null;
}

export function Trove() {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { run, busy } = useTx();
  const { signTypedDataAsync } = useSignTypedData();
  const { data: wallet } = useTrove();
  const { data: protocol } = useProtocol();

  const available = HUB.deployment ? troveContracts(HUB.deployment) !== null : false;
  const pool = protocol?.markets.find((m) => m.pool === HUB.deployment?.contracts.pMUSD);
  const supplyApy = pool ? perSecondToApy(pool.supplyRatePerSecond) : null;
  const sign: TroveSigner = (typed) => signTypedDataAsync(typed as Parameters<typeof signTypedDataAsync>[0]);
  const active = wallet?.trove.status === TROVE_STATUS.ACTIVE;
  const surplus = wallet?.trove.surplus ?? 0n;

  const claim = () => {
    if (address && hub) void run('Claim BTC surplus', claimTroveSurplusSteps());
  };

  return (
    <>
      <PageTitle
        eyebrow="CAPITAL"
        title="Mint MUSD against BTC. Put it to work at once."
        subtitle="Open a Mezo trove and supply what it mints to pMUSD in one transaction. Your supply can then repay or close the trove."
      />
      <SummaryStrip
        snapshot={
          <>
            MEZO BORROWEROPERATIONS <i>/</i> TROVEROUTER <i>/</i> pMUSD
          </>
        }
        time="The router holds nothing between transactions"
        icon={Landmark}
      />
      {!HUB_DEPLOYED && <NotDeployed />}
      {HUB_DEPLOYED && !available && <p className="action-blocked">TroveRouter is not deployed on this network.</p>}
      {available && (
        <div className="borrow-layout">
          <div>
            {active ? <ActiveTrove wallet={wallet} sign={sign} /> : <OpenForm wallet={wallet} sign={sign} connected={isConnected} />}
            {wallet && !active && <ClosedTrove status={wallet.trove.status} />}
          </div>
          <div className="borrow-side">
            {surplus > 0n && (
              <div className="panel trove-surplus">
                <PanelTitle label="BTC to claim" />
                <p className="trove-explain">{btc(surplus)} is left from a redeemed or liquidated trove.</p>
                <button className="button button--dark button--wide" onClick={claim} disabled={Boolean(busy)}>
                  {busy ?? 'Claim BTC'}
                </button>
              </div>
            )}
            <SystemPanel trove={wallet?.trove} supplyApy={supplyApy} />
            <RiskNote />
          </div>
        </div>
      )}
    </>
  );
}
