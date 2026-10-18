import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowRight, BadgeCheck, Check, Shield, Waves, X } from 'lucide-react';
import { useAccount, usePublicClient } from 'wagmi';
import { parseEventLogs, type PublicClient } from 'viem';
import { maxWithdrawableUnits, spokeGatewayAbi, wormholeAdapterAbi } from '@mezodot/sdk';
import { AmountInput, ConnectGate, InfoBar, NotDeployed, PageTitle, PanelTitle, Spinner, SummaryStrip, TxLink, PriceNotice } from '../components/ui';
import { HUB, HUB_DEPLOYED, SPOKES, spokeByWormholeChain, type SpokeInfo } from '../chain/env';
import { relayHubSteps, relaySpokeSteps, spokeDepositSteps, withdrawRemoteSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { useFlightStatus } from '../data/flights';
import { useHubClient, usePrices, useValuedPosition, useWalletBalances } from '../data/hooks';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { spendableWeth, wrapNeeded } from '../lib/wrap';
import { finalityEta, formatWait } from '../lib/eta';
import { fmt, money, timeAgo, units } from '../lib/format';
import { useUi, type Flight } from '../state/UiContext';

type Asset = 'WETH' | 'USDC';
const DECIMALS: Record<Asset, number> = { WETH: 18, USDC: 6 };
const PRICE_SYMBOL = { WETH: 'ETH', USDC: 'USDC' } as const;

export function Crosschain() {
  const { go } = useUi();
  const deployedSpokes = SPOKES.filter((s) => s.deployment);
  return (
    <>
      <PageTitle
        eyebrow="CAPITAL / 02"
        title="Collateral, without the detour."
        subtitle="Lock collateral in a SpokeGateway on Base or Ethereum Sepolia. A guardian-signed Wormhole message credits it on the Mezo Hub, where you borrow MUSD."
        right={
          <button className="button button--outline" onClick={() => go('borrow')}>
            <ArrowDownLeft size={15} /> Borrow MUSD
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            HUB & SPOKE <i>/</i> WORMHOLE CORE MESSAGING
          </>
        }
        time={`${deployedSpokes.length} spoke${deployedSpokes.length === 1 ? '' : 's'} live`}
        icon={Waves}
      />
      {!HUB_DEPLOYED && <NotDeployed />}
      <div className="cross-layout">
        <DepositPanel spokes={deployedSpokes} />
        <div className="bridge-side">
          <FlightsPanel />
          <WithdrawRemotePanel />
        </div>
      </div>
      <InfoBar title="How safety works." action="Architecture" onAction={() => go('architecture')}>
        The hub only credits collateral from VAAs signed by Wormhole guardians and emitted by a registered SpokeGateway; each VAA can be used once. Withdrawals
        debit the hub before the spoke releases.
      </InfoBar>
    </>
  );
}

function DepositPanel({ spokes }: { spokes: SpokeInfo[] }) {
  const { address, isConnected } = useAccount();
  const { addFlight } = useUi();
  const { run, busy } = useTx();
  const balances = useWalletBalances().data;
  const prices = usePrices().data?.prices;
  const [spokeName, setSpokeName] = useState(spokes[0]?.name);
  const [asset, setAsset] = useState<Asset>('WETH');
  const [amount, setAmount] = useState('');
  const spoke = spokes.find((s) => s.name === spokeName) ?? spokes[0];
  const client = usePublicClient({ chainId: spoke?.chain.id }) as PublicClient | undefined;

  if (!spoke) {
    return (
      <section className="panel bridge-config">
        <PanelTitle label="Post cross-chain collateral" meta="SpokeGateway" />
        <p className="muted-note">No spoke gateway is deployed for this environment yet.</p>
      </section>
    );
  }
  const spokeBalances = balances?.spokes[spoke.name];
  const native = spokeBalances?.native ?? 0n;
  // WETH deposits may also use native ETH (wrapped automatically); USDC must already be held.
  const balance = asset === 'WETH' ? spendableWeth(spokeBalances?.WETH ?? 0n, native, spokeBalances?.gasPrice ?? 0n) : (spokeBalances?.USDC ?? 0n);
  const toWrap = asset === 'WETH' && parseInput(amount, 18) !== null ? wrapNeeded(spokeBalances?.WETH ?? 0n, parseInput(amount, 18)!) : 0n;
  const parsed = parseInput(amount, DECIMALS[asset]);
  const invalid = parsed === null || parsed > balance;
  const usd = parsed ? units(parsed, DECIMALS[asset]) * (prices?.[PRICE_SYMBOL[asset]] ?? 0) : 0;

  const deposit = async () => {
    if (!address || !client || !parsed) return;
    const token = spoke.deployment!.tokens[asset];
    const result = await run(
      `Lock ${asset} on ${spoke.label}`,
      spokeDepositSteps(address, spoke, client, token, asset, parsed, { wrapNative: asset === 'WETH' }),
    );
    if (!result.ok) return;
    const receipt = result.receipts[result.receipts.length - 1];
    const [event] = parseEventLogs({ abi: spokeGatewayAbi, logs: receipt.logs, eventName: 'Deposited' });
    if (event) {
      addFlight({
        id: `${spoke.wormholeChainId}/${spoke.deployment!.contracts.spokeGateway.toLowerCase()}/${event.args.sequence}`,
        direction: 'deposit',
        source: spoke.name,
        target: HUB.name,
        emitterChain: spoke.wormholeChainId,
        emitter: spoke.deployment!.contracts.spokeGateway,
        sequence: event.args.sequence.toString(),
        txHash: receipt.transactionHash,
        label: `${fmt(units(parsed, DECIMALS[asset]), 4)} ${asset} from ${spoke.label}`,
        createdAt: Date.now(),
      });
      setAmount('');
    }
  };

  return (
    <section className="panel bridge-config">
      <PanelTitle label="Post cross-chain collateral" meta="SpokeGateway → WormholeAdapter → VaultManager" />
      <div className="form-section">
        <span className="field-label">01 / SOURCE CHAIN</span>
        <div className="chain-options">
          {spokes.map((s) => {
            const selected = s.name === spoke.name;
            return (
              <button key={s.name} className={`chain-option ${selected ? 'is-selected' : ''}`} onClick={() => setSpokeName(s.name)} aria-pressed={selected}>
                <span className="chain-disc" style={{ background: s.name.startsWith('base') ? '#3d66ad' : '#6b77bc' }}>
                  {s.label[0]}
                </span>
                <span>
                  <b>{s.label}</b>
                  <small>Wormhole chain {s.wormholeChainId}</small>
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
          {(['WETH', 'USDC'] as const).map((a) => (
            <button key={a} className={`asset-choice ${asset === a ? 'is-selected' : ''}`} onClick={() => setAsset(a)} aria-pressed={asset === a}>
              <span className={`coin-mini ${a === 'WETH' ? 'coin-eth' : 'coin-usdc'}`}>{a === 'WETH' ? 'Ξ' : '$'}</span>
              <b>{a}</b>
              <span>{money(prices?.[PRICE_SYMBOL[a]] ?? 0, 2)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="form-section">
        <label className="field-label" htmlFor="bridge-amount">
          03 / AMOUNT{' '}
          <span>
            {spoke.label} balance ·{' '}
            {asset === 'WETH'
              ? `${fmt(units(spokeBalances?.WETH ?? 0n, 18), 4)} WETH + ${fmt(units(native, 18), 4)} ETH`
              : `${fmt(units(balance, DECIMALS[asset]), 4)} ${asset}`}
          </span>
        </label>
        <AmountInput id="bridge-amount" value={amount} onChange={setAmount} unit={asset} onMax={() => setAmount(toInput(balance, DECIMALS[asset]))} />
        <div className="amount-estimate">
          Value <b>{money(usd, 2)}</b>
          {toWrap > 0n && <> · wraps {fmt(units(toWrap, 18), 4)} ETH → WETH first</>}
        </div>
      </div>
      <ConnectGate connected={isConnected}>
        <button className="button button--dark button--wide" onClick={deposit} disabled={invalid || Boolean(busy)}>
          {busy ?? (
            <>
              Lock on {spoke.label} <ArrowRight size={15} />
            </>
          )}
        </button>
      </ConnectGate>
      <div className="small-disclosure">
        <Shield size={14} /> Wrap (if needed), approve and lock on {spoke.label}; your hub account is the same address. Credit arrives once {spoke.label}{' '}
        finalizes the lock, ≈ {Math.round(spoke.finalitySec / 60)} min (Wormhole guardians wait for finality).
      </div>
    </section>
  );
}

function FlightRow({ flight }: { flight: Flight }) {
  const { removeFlight } = useUi();
  const { run, busy } = useTx();
  const status = useFlightStatus(flight).data;
  const stage = status?.stage ?? 1;
  const queryClient = useQueryClient();
  // Refresh balances and position the moment the message lands, instead of on the next poll.
  useEffect(() => {
    if (status?.delivered) void queryClient.invalidateQueries();
  }, [status?.delivered, queryClient]);
  const source = flight.source === HUB.name ? HUB : SPOKES.find((s) => s.name === flight.source)!;
  const steps =
    flight.direction === 'deposit'
      ? ['Locked on spoke', 'Guardians signed VAA', 'Credited by VaultManager', 'Borrow capacity live']
      : ['Debited on hub', 'Guardians signed VAA', 'Released on spoke', 'Tokens in wallet'];
  const ageMin = (Date.now() - flight.createdAt) / 60_000;
  const canSelfRelay = status?.vaa && !status.delivered && ageMin > 0.5;
  // Guardians sign once the source block is final: the wait is set by the source chain (re-rendered on each poll).
  const eta = finalityEta(flight.createdAt, source.finalitySec, Date.now());
  const finalityMin = Math.max(1, Math.round(source.finalitySec / 60));
  const hint = (i: number): string | null => {
    if (status?.delivered || stage !== i) return null;
    if (i === 1) {
      return eta.overdue
        ? `Taking longer than usual (${source.label} finality ≈ ${finalityMin} min). Funds stay locked safely until the guardians sign.`
        : `${formatWait(eta.remainingSec)} · waiting for ${source.label} finality (≈ ${finalityMin} min)`;
    }
    if (i === 2) return 'Relaying · usually under a minute';
    return null;
  };

  const selfRelay = () => {
    if (!status?.vaa) return;
    const target = SPOKES.find((s) => s.name === flight.target);
    void run('Deliver message', flight.direction === 'deposit' ? relayHubSteps(status.vaa) : relaySpokeSteps(target!, status.vaa));
  };

  return (
    <div className="flight">
      <div className="flight-head">
        <b>{flight.label}</b>
        <span>
          <TxLink network={source} hash={flight.txHash} /> · {timeAgo(flight.createdAt)}
          {status?.delivered && (
            <button className="icon-button" onClick={() => removeFlight(flight.id)} aria-label="Dismiss">
              <X size={13} />
            </button>
          )}
        </span>
      </div>
      <ol className="message-steps" aria-live="polite">
        {steps.map((label, i) => {
          const done = stage > i || (stage === 4 && i === 3);
          const current = !done && stage === i;
          return (
            <li className={`message-step ${done ? 'step-done' : ''} ${current ? 'step-current' : ''}`} key={label}>
              <span>{done ? <Check size={11} /> : current ? <Spinner /> : `0${i + 1}`}</span>
              <div>
                <b>{label}</b>
                {hint(i) && <small className="step-hint">{hint(i)}</small>}
              </div>
              {done && <BadgeCheck size={14} />}
            </li>
          );
        })}
      </ol>
      {canSelfRelay && (
        <button className="button button--outline" onClick={selfRelay} disabled={Boolean(busy)}>
          {busy ?? 'Relay it yourself'}
        </button>
      )}
      {!status?.delivered && <p className="muted-note">Relayer: {status?.relayer ?? '…'}</p>}
    </div>
  );
}

function FlightsPanel() {
  const { flights } = useUi();
  return (
    <section className="panel timeline-panel">
      <PanelTitle label="Message lifecycle" meta="Wormhole · live" />
      {flights.length === 0 && <p className="muted-note">Messages you send appear here and are tracked until delivered.</p>}
      {flights.slice(0, 4).map((f) => (
        <FlightRow key={f.id} flight={f} />
      ))}
    </section>
  );
}

function WithdrawRemotePanel() {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { addFlight } = useUi();
  const { run, busy } = useTx();
  const { valued, protocol, position, unpriced, relayError } = useValuedPosition();
  const remote = valued?.collateral.filter((c) => c.collateral.isRemote && c.balance > 0n) ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const row = remote.find((r) => r.collateral.id === selected) ?? remote[0];

  if (!protocol) return null;
  // Spoke collateral that backs debt can only partly leave; with no debt all of it can.
  const maxOut =
    !row || !valued
      ? 0n
      : valued.debtUsd <= 0
        ? row.balance
        : (() => {
            const byHealth = floorUnits(maxWithdrawableUnits(valued, row.collateral.id), row.collateral.decimals);
            return byHealth < row.balance ? byHealth : row.balance;
          })();
  const parsed = row ? parseInput(amount, row.collateral.decimals) : null;
  const invalid = !row || parsed === null || parsed > maxOut;

  const withdraw = async () => {
    if (!address || !hub || !row || !parsed) return;
    const spoke = spokeByWormholeChain(row.collateral.chainId);
    const ctx = { account: address, hub, protocol, position: position ?? null };
    const result = await run(`Release ${row.collateral.symbol}`, withdrawRemoteSteps(ctx, row.collateral, parsed));
    if (!result.ok || !spoke) return;
    const receipt = result.receipts[0];
    const [event] = parseEventLogs({ abi: wormholeAdapterAbi, logs: receipt.logs, eventName: 'ReleaseSent' });
    if (event) {
      addFlight({
        id: `${HUB.wormholeChainId}/${HUB.deployment!.contracts.wormholeAdapter.toLowerCase()}/${event.args.sequence}`,
        direction: 'release',
        source: HUB.name,
        target: spoke.name,
        emitterChain: HUB.wormholeChainId,
        emitter: HUB.deployment!.contracts.wormholeAdapter,
        sequence: event.args.sequence.toString(),
        txHash: receipt.transactionHash,
        label: `${fmt(units(parsed, row.collateral.decimals), 4)} ${row.collateral.symbol} back to ${spoke.label}`,
        createdAt: Date.now(),
      });
      setAmount('');
    }
  };

  return (
    <section className="panel route-panel">
      <PanelTitle label="Withdraw to a spoke" meta="VaultManager.withdrawRemote" />
      {valued && valued.debtUsd > 0 && <PriceNotice unpriced={unpriced} relayError={relayError} />}
      {remote.length === 0 ? (
        <p className="muted-note">{isConnected ? 'No spoke collateral posted.' : 'Connect a wallet to manage spoke collateral.'}</p>
      ) : (
        <>
          <div className="asset-select-row">
            {remote.map((r) => (
              <button
                key={r.collateral.id}
                className={`asset-choice ${row?.collateral.id === r.collateral.id ? 'is-selected' : ''}`}
                onClick={() => setSelected(r.collateral.id)}
              >
                <b>{r.collateral.symbol}</b>
                <span>
                  {fmt(r.units, 4)} · {spokeByWormholeChain(r.collateral.chainId)?.label ?? `chain ${r.collateral.chainId}`}
                </span>
              </button>
            ))}
          </div>
          <AmountInput
            id="withdraw-remote"
            value={amount}
            onChange={setAmount}
            unit={row?.collateral.symbol ?? ''}
            onMax={() => row && setAmount(toInput(maxOut, row.collateral.decimals))}
          />
          <button className="button button--light button--wide" onClick={withdraw} disabled={invalid || Boolean(busy)}>
            {busy ?? 'Release on spoke'}
          </button>
          <p className="muted-note">
            Up to {row ? fmt(units(maxOut, row.collateral.decimals), 6) : '0'} {row?.collateral.symbol} can leave while your debt stays within the borrow limit.
            Tokens arrive on the spoke ≈ {Math.max(1, Math.round(HUB.finalitySec / 60))} min after the hub transaction (Mezo is final at once).
          </p>
        </>
      )}
    </section>
  );
}
