import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowRight, Bitcoin, Check, Shield, TriangleAlert, Waves, X } from 'lucide-react';
import { useAccount, usePublicClient } from 'wagmi';
import { isAddressEqual, type Address, type Hash, type PublicClient } from 'viem';
import { healthStatus, maxWithdrawableUnits } from '@mezodot/sdk';
import { HubPending, QueryError } from '../components/StatusBanners';
import { AmountInput, ConnectGate, InfoBar, NotDeployed, PageTitle, PanelTitle, Spinner, SummaryStrip, TxLink, PriceNotice } from '../components/ui';
import { HUB, HUB_DEPLOYED, SPOKES, networkByName, spokeByWormholeChain, type SpokeInfo } from '../chain/env';
import { claimSteps, relayHubSteps, relaySpokeSteps, spokeDepositSteps, withdrawRemoteSteps } from '../chain/actions';
import { useTx } from '../chain/tx';
import { useActivity } from '../data/activity';
import { claimRecipient, useSpokeClaims, type SpokeClaim } from '../data/claims';
import { flightId, pendingFlightId, recoverFlights, releaseHeld, sequenceFromLogs, useFlightStatus, useReleaseOutcome } from '../data/flights';
import { lockBlocked, lockRoom, useSpokeLockState } from '../data/guards';
import { readError, useHubClient, usePosition, usePrices, useSpokeClients, useValuedPosition, useWalletBalances } from '../data/hooks';
import { truncatedUnits } from '../data/limits';
import { floorUnits, parseInput, toInput } from '../lib/amount';
import { spendableWeth, wrapNeeded } from '../lib/wrap';
import { finalityEta, formatWait } from '../lib/eta';
import { ChainLogo, TokenLogo } from '../components/Logos';
import { fmt, fmtHealth, money, shortAddress, timeAgo, units } from '../lib/format';
import { useUi, type Flight } from '../state/UiContext';

type Asset = 'WETH' | 'USDC';
const DECIMALS: Record<Asset, number> = { WETH: 18, USDC: 6 };
const PRICE_SYMBOL = { WETH: 'ETH', USDC: 'USDC' } as const;

/** Mezo Passport's Bitcoin wallets act through a smart account that exists only on Mezo: they cannot sign on a spoke. */
const useBitcoinWallet = () => useAccount().connector?.type === 'orangekit';

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
          <ClaimsPanel />
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
  const bitcoinWallet = useBitcoinWallet();
  const { addFlight, updateFlight, removeFlight } = useUi();
  const { run, busy } = useTx();
  const hub = useHubClient();
  const balanceQuery = useWalletBalances();
  const balances = balanceQuery.data;
  const prices = usePrices().data?.prices;
  const [spokeName, setSpokeName] = useState(spokes[0]?.name);
  const [asset, setAsset] = useState<Asset>('WETH');
  const [amount, setAmount] = useState('');
  const spoke = spokes.find((s) => s.name === spokeName) ?? spokes[0];
  const client = usePublicClient({ chainId: spoke?.chain.id }) as PublicClient | undefined;
  const token = spoke?.deployment?.tokens[asset];
  const lock = useSpokeLockState(spoke, token).data;

  if (!spoke) {
    return (
      <section className="panel bridge-config">
        <PanelTitle label="Post cross-chain collateral" meta="SpokeGateway" />
        <p className="muted-note">No spoke gateway is deployed for this environment yet.</p>
      </section>
    );
  }
  // Unknown (undefined) until this spoke's balances and gas price are read: never shown or used as zero.
  const spokeBalances = balances?.spokes[spoke.name];
  const balanceError = balances?.spokeErrors[spoke.name] ?? (balanceQuery.error && !balances ? readError(balanceQuery.error) : null);
  // WETH deposits may also use native ETH (wrapped automatically); USDC must already be held.
  const balance = spokeBalances
    ? asset === 'WETH'
      ? spendableWeth(spokeBalances.WETH, spokeBalances.native, spokeBalances.gasPrice)
      : spokeBalances.USDC
    : undefined;
  const room = lock ? lockRoom(lock) : undefined;
  // The gateway's cap can bind before the wallet does.
  const capBound = balance !== undefined && room !== undefined && room < balance;
  const max = capBound ? room : balance;
  const blocked = lock ? lockBlocked(lock, spoke.label, asset) : null;
  const parsed = parseInput(amount, DECIMALS[asset]);
  const toWrap = asset === 'WETH' && parsed !== null && spokeBalances ? wrapNeeded(spokeBalances.WETH, parsed) : 0n;
  const overMax = parsed !== null && max !== undefined && parsed > max;
  const invalid = parsed === null || max === undefined || overMax || blocked !== null || bitcoinWallet;
  const usd = parsed ? units(parsed, DECIMALS[asset]) * (prices?.[PRICE_SYMBOL[asset]] ?? 0) : 0;

  const deposit = async () => {
    if (!address || !client || !hub || !parsed || !token || !spoke.deployment) return;
    const gateway = spoke.deployment.contracts.spokeGateway;
    const steps = spokeDepositSteps(address, spoke, { spoke: client, hub }, token, asset, parsed, { wrapNative: asset === 'WETH' });
    const lockStep = steps[steps.length - 1];
    const recorded: { id: string | null } = { id: null };
    const result = await run(`Lock ${asset} on ${spoke.label}`, steps, {
      // Recorded as soon as the lock is signed, so a reload or a slow receipt never loses the flight.
      onSubmitted: (step, hash: Hash) => {
        if (step !== lockStep) return;
        // A lock sent again after running out of gas replaces the first attempt, which moved nothing.
        if (recorded.id) removeFlight(recorded.id);
        recorded.id = pendingFlightId(hash);
        addFlight({
          id: recorded.id,
          direction: 'deposit',
          source: spoke.name,
          target: HUB.name,
          emitterChain: spoke.wormholeChainId,
          emitter: gateway,
          sequence: null,
          txHash: hash,
          label: `${fmt(units(parsed, DECIMALS[asset]), 4)} ${asset} from ${spoke.label}`,
          createdAt: Date.now(),
        });
      },
    });
    if (!recorded.id) return;
    if (result.ok) {
      const sequence = sequenceFromLogs({ direction: 'deposit' }, result.receipts[result.receipts.length - 1].logs);
      if (sequence) updateFlight(recorded.id, { id: flightId(spoke.wormholeChainId, gateway, sequence), sequence });
      setAmount('');
    } else if (!result.pending) {
      removeFlight(recorded.id); // the lock reverted: nothing to track (the toast says why)
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
                <ChainLogo network={s.name} />
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
              <TokenLogo symbol={a} size={19} />
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
            {!spokeBalances
              ? isConnected
                ? balanceError
                  ? 'unavailable'
                  : '…'
                : '—'
              : asset === 'WETH'
                ? `${fmt(units(spokeBalances.WETH, 18), 4)} WETH + ${fmt(units(spokeBalances.native, 18), 4)} ETH`
                : `${fmt(units(spokeBalances.USDC, DECIMALS[asset]), 4)} ${asset}`}
          </span>
        </label>
        <AmountInput
          id="bridge-amount"
          value={amount}
          onChange={setAmount}
          unit={asset}
          onMax={max === undefined ? undefined : () => setAmount(toInput(max, DECIMALS[asset]))}
        />
        <div className="amount-estimate">
          Value <b>{money(usd, 2)}</b>
          {toWrap > 0n && <> · wraps {fmt(units(toWrap, 18), 4)} ETH → WETH first</>}
        </div>
        {isConnected && balanceError && (
          <p className="inline-error" role="alert">
            Could not read your {spoke.label} balance: {balanceError}.{' '}
            <button className="text-link" onClick={() => void balanceQuery.refetch()}>
              Retry
            </button>
          </p>
        )}
        {overMax && max !== undefined && (
          <p className="inline-error" role="alert">
            Amount exceeds {capBound ? `what the ${spoke.label} gateway still accepts under its cap` : `your ${spoke.label} balance`}: at most{' '}
            {fmt(units(max, DECIMALS[asset]), 6)} {asset}
            {asset === 'WETH' && !capBound ? ', keeping ETH back for the wrap, approve and lock fees' : ''}.
          </p>
        )}
      </div>
      {bitcoinWallet ? (
        <div className="connect-gate" role="status">
          <Bitcoin size={16} />
          <span>
            Bitcoin wallets sign through a Mezo smart account, which exists only on {HUB.label}. Connect an EVM wallet (MetaMask, Rabby) to lock collateral on{' '}
            {spoke.label}.
          </span>
        </div>
      ) : (
        <ConnectGate connected={isConnected}>
          <button className="button button--dark button--wide" onClick={deposit} disabled={invalid || Boolean(busy)}>
            {busy ?? (
              <>
                Lock on {spoke.label} <ArrowRight size={15} />
              </>
            )}
          </button>
        </ConnectGate>
      )}
      {blocked && <p className="action-blocked">{blocked}</p>}
      <div className="small-disclosure">
        <Shield size={14} /> Wrap (if needed), approve and lock on {spoke.label}. The hub credits the same EVM address you lock from. Credit arrives once{' '}
        {spoke.label} finalizes the lock, ≈ {Math.round(spoke.finalitySec / 60)} min (Wormhole guardians wait for finality).
      </div>
    </section>
  );
}

/** Flights listed before \"Show all\": in-flight messages stay visible, delivered ones are a single line each. */
const MAX_FLIGHTS_SHOWN = 4;

function FlightRow({ flight }: { flight: Flight }) {
  const { removeFlight, updateFlight } = useUi();
  const bitcoinWallet = useBitcoinWallet();
  const { run, busy } = useTx();
  const statusQuery = useFlightStatus(flight);
  const status = statusQuery.data;
  const queryClient = useQueryClient();
  // Refresh balances and position the moment the message lands, instead of on the next poll.
  useEffect(() => {
    if (status?.delivered) void queryClient.invalidateQueries();
  }, [status?.delivered, queryClient]);
  // A flight recorded at signing learns its Wormhole sequence from the receipt.
  useEffect(() => {
    if (flight.sequence === null && status?.sequence) {
      updateFlight(flight.id, { id: flightId(flight.emitterChain, flight.emitter, status.sequence), sequence: status.sequence });
    }
  }, [flight.id, flight.sequence, flight.emitterChain, flight.emitter, status?.sequence, updateFlight]);
  // Rebuilt from events and already delivered: history, not something to track.
  useEffect(() => {
    if (flight.recovered && status?.delivered) removeFlight(flight.id);
  }, [flight.recovered, flight.id, status?.delivered, removeFlight]);
  // Delivered, but the gateway could not transfer the tokens (ReleaseDeferred): they wait in "Ready to claim". That is
  // decided per message: only while the account has a claim on this spoke is this release's own delivery looked up.
  const claims = useSpokeClaims().data?.claims;
  const delivered = Boolean(status?.delivered);
  const claimOnTarget = flight.direction === 'release' && delivered && Boolean(claims?.some((c) => c.spoke.name === flight.target));
  const lookedUp = useReleaseOutcome(flight, status?.vaa ?? null, claimOnTarget && !status?.outcome).data;
  const deferred = releaseHeld(flight, delivered, status?.outcome ?? lookedUp, claims);

  const source = networkByName(flight.source);
  const target = networkByName(flight.target);
  if (!source || !target) return null;
  const stage = deferred ? 3 : (status?.stage ?? 1);
  const steps =
    flight.direction === 'deposit'
      ? ['Locked on spoke', 'Guardians signed VAA', 'Credited by VaultManager', 'Borrow capacity live']
      : ['Debited on hub', 'Guardians signed VAA', 'Released on spoke', 'Tokens in wallet'];
  // The step under way, worded as it happens (the list above reads as done).
  const activeSteps =
    flight.direction === 'deposit'
      ? ['Locking on the spoke', 'Guardians sign the VAA', 'Crediting on the hub', 'Opening borrow capacity']
      : ['Debiting on the hub', 'Guardians sign the VAA', 'Releasing on the spoke', 'Sending tokens to your wallet'];
  const ageMin = (Date.now() - flight.createdAt) / 60_000;
  // Delivering a release means signing on the spoke, which Bitcoin wallets cannot do.
  const canSelfRelay = status?.vaa && !status.delivered && ageMin > 0.5 && !(bitcoinWallet && flight.direction === 'release');
  // Guardians sign once the source block is final: the wait is set by the source chain (re-rendered on each poll).
  const eta = finalityEta(flight.createdAt, source.finalitySec, Date.now());
  const finalityMin = Math.max(1, Math.round(source.finalitySec / 60));
  const hint = (i: number): string | null => {
    if (deferred) return i === 3 ? `The transfer to your wallet failed on delivery, so the ${target.label} gateway holds the tokens: claim them above.` : null;
    if (status?.delivered || stage !== i) return null;
    if (i === 1) {
      if (flight.sequence === null && (status?.sourcePending ?? true)) return `Waiting for the ${source.label} transaction to confirm…`;
      return eta.overdue
        ? `Taking longer than usual (${source.label} finality ≈ ${finalityMin} min). Funds stay locked safely until the guardians sign.`
        : `${formatWait(eta.remainingSec)} · waiting for ${source.label} finality (≈ ${finalityMin} min)`;
    }
    if (i === 2) return 'Relaying · usually under a minute';
    return null;
  };

  const selfRelay = () => {
    if (!status?.vaa) return;
    const spoke = SPOKES.find((s) => s.name === flight.target);
    if (flight.direction === 'release' && !spoke) return;
    void run('Deliver message', flight.direction === 'deposit' ? relayHubSteps(status.vaa) : relaySpokeSteps(spoke!, status.vaa));
  };

  const delivered4 = Boolean(status?.delivered) && !deferred;
  const tone = status?.failed ? 'bad' : deferred ? 'warn' : delivered4 ? 'ok' : 'live';
  const pill = status?.failed
    ? 'Failed'
    : deferred
      ? 'Claim needed'
      : delivered4
        ? 'Delivered'
        : stage <= 1
          ? flight.sequence === null && (status?.sourcePending ?? true)
            ? 'Confirming'
            : 'Waiting for finality'
          : stage === 2
            ? 'Relaying'
            : flight.direction === 'deposit'
              ? 'Crediting'
              : 'Releasing';
  const doneCount = delivered4 ? steps.length : Math.min(stage, steps.length);
  const caption = status?.failed
    ? `${status.failed}; your funds did not move.`
    : deferred
      ? hint(3)
      : delivered4
        ? flight.direction === 'deposit'
          ? `Credited on ${target.label}: it counts toward your borrow limit.`
          : `Released on ${target.label} to your wallet.`
        : `Step ${stage + 1} of ${steps.length} · ${activeSteps[stage]}${hint(stage) ? ` · ${hint(stage)}` : ''}`;

  return (
    <article className={`flight-card flight-card--${tone}`} aria-label={flight.label}>
      <div className="flight-main">
        <span className="flight-route" aria-label={`${source.label} to ${target.label}`}>
          <ChainLogo network={source.name} size={20} />
          <ArrowRight size={12} />
          <ChainLogo network={target.name} size={20} />
        </span>
        <div className="flight-text">
          <b>{flight.label}</b>
          <small>
            {timeAgo(flight.createdAt)} · <TxLink network={source} hash={flight.txHash} />
          </small>
        </div>
        <span className={`flight-pill flight-pill--${tone}`}>
          {tone === 'live' && <Spinner />}
          {tone === 'ok' && <Check size={11} />}
          {(tone === 'warn' || tone === 'bad') && <TriangleAlert size={11} />}
          {pill}
        </span>
        <button
          className="icon-button flight-dismiss"
          onClick={() => removeFlight(flight.id)}
          aria-label={status?.delivered || status?.failed ? 'Dismiss' : 'Stop tracking this message (delivery continues)'}
          title={status?.delivered || status?.failed ? 'Dismiss' : 'Stop tracking (delivery continues)'}
        >
          <X size={13} />
        </button>
      </div>
      {!status?.failed && (
        <div className="flight-progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} aria-label={pill}>
          {steps.map((label, i) => (
            <span key={label} className={i < doneCount ? 'is-done' : i === doneCount && !delivered4 ? 'is-current' : ''} title={label} />
          ))}
        </div>
      )}
      <p className={`flight-caption ${status?.failed ? 'is-error' : ''}`} aria-live="polite">
        {caption}
      </p>
      {(canSelfRelay || !delivered4) && !status?.failed && (
        <div className="flight-foot">
          {!status?.delivered && <span>Relayer: {status?.relayer ?? '…'}</span>}
          {canSelfRelay && (
            <button className="button button--outline button--small" onClick={selfRelay} disabled={Boolean(busy)}>
              {busy ?? 'Relay it yourself'}
            </button>
          )}
        </div>
      )}
      {statusQuery.error && (
        <p className="inline-error" role="status">
          Could not check this message right now: {readError(statusQuery.error)}. It is checked again every few seconds.
        </p>
      )}
    </article>
  );
}

/** Releases the spoke gateway could not transfer on delivery: it holds them until the recipient claims them. */
function ClaimsPanel() {
  const { address } = useAccount();
  const bitcoinWallet = useBitcoinWallet();
  const claims = useSpokeClaims().data?.claims ?? [];
  if (!address || claims.length === 0) return null;

  return (
    <section className="panel route-panel" aria-label="Releases ready to claim">
      <PanelTitle label="Ready to claim" meta="SpokeGateway.claim" />
      <p className="muted-note">
        These releases reached the spoke, but the token transfer to your wallet failed on delivery, so the gateway holds them for you. Claim them to your
        wallet, or to another address you control if the token refuses transfers to this one.
      </p>
      <div className="claim-list">
        {claims.map((c) => (
          <ClaimRow key={`${c.spoke.name}-${c.symbol}`} claim={c} account={address} />
        ))}
      </div>
      {bitcoinWallet && <p className="muted-note">Claiming means signing on the spoke: connect an EVM wallet (MetaMask, Rabby) to claim.</p>}
    </section>
  );
}

/** One claimable balance: SpokeGateway.claim(token, to), to the wallet or to an address the user enters. */
function ClaimRow({ claim, account }: { claim: SpokeClaim; account: Address }) {
  const bitcoinWallet = useBitcoinWallet();
  const { run, busy } = useTx();
  const clients = useSpokeClients();
  // null: claim to the connected wallet; text: the other recipient being entered.
  const [other, setOther] = useState<string | null>(null);
  // A claim to the wallet failed: the token may refuse it, which is what deferred the release in the first place.
  const [walletFailed, setWalletFailed] = useState(false);
  const gateway = claim.spoke.deployment?.contracts.spokeGateway;
  const recipient = gateway ? claimRecipient(other ?? '', { account, token: claim.token, gateway }) : null;
  const toWallet = recipient?.to ? isAddressEqual(recipient.to, account) : false;
  const inputId = `claim-to-${claim.spoke.name}-${claim.symbol}`;

  const send = async () => {
    const client = clients[SPOKES.indexOf(claim.spoke)];
    if (!client || !recipient?.to) return;
    const result = await run(
      `Claim ${claim.symbol} on ${claim.spoke.label}`,
      claimSteps(account, claim.spoke, client, claim.token, claim.symbol, recipient.to),
    );
    // Only a transfer the token refused points to claiming elsewhere; a declined signature is just a retry.
    if (!result.ok && !result.pending && !result.rejected && toWallet) setWalletFailed(true);
  };

  return (
    <div className="claim-item">
      <div className="claim-row">
        <div className="collateral-detail">
          <TokenLogo symbol={claim.symbol} network={claim.spoke.name} size={23} />
          <span>
            <b>
              {fmt(units(claim.amount, claim.decimals), 6)} {claim.symbol}
            </b>
            <small>Held by the {claim.spoke.label} gateway</small>
          </span>
        </div>
        <button className="button button--outline" onClick={() => void send()} disabled={Boolean(busy) || bitcoinWallet || !recipient?.to}>
          {busy ?? (toWallet ? 'Claim to wallet' : recipient?.to ? `Claim to ${shortAddress(recipient.to)}` : 'Claim to this address')}
        </button>
      </div>
      {other === null ? (
        <button className="text-link claim-other" onClick={() => setOther('')}>
          Send to another address
        </button>
      ) : (
        <div className="claim-recipient">
          <label className="field-label" htmlFor={inputId}>
            RECIPIENT <span>Empty: your wallet</span>
          </label>
          <div className="amount-input">
            <input id={inputId} type="text" placeholder="0x…" spellCheck={false} autoComplete="off" value={other} onChange={(e) => setOther(e.target.value)} />
            <button type="button" onClick={() => setOther(null)}>
              WALLET
            </button>
          </div>
          {recipient?.error && (
            <p className="inline-error" role="alert">
              {recipient.error}
            </p>
          )}
        </div>
      )}
      {walletFailed && toWallet && (
        <p className="muted-note">
          The claim to your wallet did not go through. If the token refuses transfers to this wallet (a blacklisted address, for example), send it to another
          address you control instead.
        </p>
      )}
    </div>
  );
}

function FlightsPanel() {
  const { flights, dismissedFlights, addFlight } = useUi();
  const activity = useActivity().data?.items;
  const [showAll, setShowAll] = useState(false);
  // Messages this browser is not tracking (another device, cleared storage) come back from on-chain events.
  useEffect(() => {
    if (!activity) return;
    for (const f of recoverFlights(activity, { flights, dismissed: dismissedFlights }, Date.now()).reverse()) addFlight(f);
  }, [activity, flights, dismissedFlights, addFlight]);
  // Newest first; FlightRow collapses delivered ones to a single line, so the list stays short.
  const shown = showAll ? flights : flights.slice(0, MAX_FLIGHTS_SHOWN);
  return (
    <section className="panel timeline-panel">
      <PanelTitle label="Message lifecycle" meta={flights.length > 0 ? `Wormhole · live · ${flights.length} tracked` : 'Wormhole · live'} />
      {flights.length === 0 && <p className="muted-note">Messages you send appear here and are tracked until delivered.</p>}
      <div className="flight-list">
        {shown.map((f) => (
          <FlightRow key={f.id} flight={f} />
        ))}
      </div>
      {flights.length > MAX_FLIGHTS_SHOWN && (
        <button className="text-link flight-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${flights.length}`}
        </button>
      )}
    </section>
  );
}

function WithdrawRemotePanel() {
  const { address, isConnected } = useAccount();
  const hub = useHubClient();
  const { addFlight, updateFlight, removeFlight } = useUi();
  const { run, busy } = useTx();
  const { valued, protocol, position, unpriced, relayError } = useValuedPosition();
  const positionQuery = usePosition();
  const remote = valued?.collateral.filter((c) => c.collateral.isRemote && c.balance > 0n) ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const pendingRef = useRef<string | null>(null);
  const row = remote.find((r) => r.collateral.id === selected) ?? remote[0];

  if (!protocol) {
    // Waiting on (or failing) the hub read: say which, instead of a panel that silently disappears.
    return HUB_DEPLOYED ? (
      <section className="panel route-panel">
        <PanelTitle label="Withdraw to a spoke" meta="VaultManager.withdrawRemote" />
        <HubPending what="your spoke collateral" />
      </section>
    ) : null;
  }
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
    if (!address || !hub || !row || !parsed || !HUB.deployment) return;
    const spoke = spokeByWormholeChain(row.collateral.chainId);
    const adapter = HUB.deployment.contracts.wormholeAdapter;
    const ctx = { account: address, hub, protocol, position: position ?? null };
    pendingRef.current = null;
    const result = await run(`Release ${row.collateral.symbol}`, withdrawRemoteSteps(ctx, row.collateral, parsed), {
      onSubmitted: (_step, hash) => {
        if (!spoke) return;
        // A release sent again after running out of gas replaces the first attempt, which moved nothing.
        if (pendingRef.current) removeFlight(pendingRef.current);
        pendingRef.current = pendingFlightId(hash);
        addFlight({
          id: pendingRef.current,
          direction: 'release',
          source: HUB.name,
          target: spoke.name,
          emitterChain: HUB.wormholeChainId,
          emitter: adapter,
          sequence: null,
          txHash: hash,
          label: `${fmt(units(parsed, row.collateral.decimals), 4)} ${row.collateral.symbol} back to ${spoke.label}`,
          createdAt: Date.now(),
        });
      },
    });
    const pending = pendingRef.current;
    if (!pending) return;
    if (!result.ok) {
      if (!result.pending) removeFlight(pending); // the release reverted: nothing to track (the toast says why)
      return;
    }
    const sequence = sequenceFromLogs({ direction: 'release' }, result.receipts[0].logs);
    if (sequence) updateFlight(pending, { id: flightId(HUB.wormholeChainId, adapter, sequence), sequence });
    setAmount('');
  };

  const spoke = row ? spokeByWormholeChain(row.collateral.chainId) : undefined;
  const value = parsed ?? 0n;
  const usd = row ? units(value, row.collateral.decimals) * row.price : 0;
  // What leaving this collateral does to health: it stops counting at its liquidation threshold.
  const hfAfter = valued && row && valued.debtUsd > 0 ? (valued.adjustedCollateralUsd - (usd * row.collateral.ltBps) / 10_000) / valued.debtUsd : Infinity;
  const overMax = row !== undefined && parsed !== null && parsed > maxOut;
  const etaMin = Math.max(1, Math.round(HUB.finalitySec / 60));

  return (
    <section className="panel bridge-config withdraw-panel">
      <PanelTitle label="Withdraw to a spoke" meta="VaultManager.withdrawRemote" />
      {valued && valued.debtUsd > 0 && <PriceNotice unpriced={unpriced} relayError={relayError} />}
      {remote.length === 0 ? (
        !isConnected ? (
          <p className="muted-note">Connect a wallet to manage spoke collateral.</p>
        ) : valued ? (
          <p className="muted-note">No spoke collateral posted. Collateral you lock on a spoke appears here once the hub credits it.</p>
        ) : positionQuery.error ? (
          <QueryError error={positionQuery.error} what="your position" onRetry={() => void positionQuery.refetch()} />
        ) : (
          <HubPending what="your position" />
        )
      ) : (
        <>
          <div className="form-section">
            <span className="field-label">01 / SPOKE COLLATERAL</span>
            <div className="withdraw-options" role="group" aria-label="Spoke collateral to withdraw">
              {remote.map((r) => {
                const isSelected = row?.collateral.id === r.collateral.id;
                const on = spokeByWormholeChain(r.collateral.chainId);
                return (
                  <button
                    key={r.collateral.id}
                    className={`chain-option withdraw-option ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setSelected(r.collateral.id)}
                    aria-pressed={isSelected}
                  >
                    <TokenLogo symbol={r.collateral.symbol} network={on?.name} size={26} />
                    <span>
                      <b>
                        {truncatedUnits(r.balance, r.collateral.decimals, 6)} {r.collateral.symbol}
                      </b>
                      <small>
                        on {on?.label ?? `chain ${r.collateral.chainId}`} · {money(r.valueUsd, 2)}
                      </small>
                    </span>
                    {isSelected && <Check size={16} />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="form-section">
            <label className="field-label" htmlFor="withdraw-remote">
              02 / AMOUNT{' '}
              <span>
                Max {row ? truncatedUnits(maxOut, row.collateral.decimals, 6) : '0'} {row?.collateral.symbol}
              </span>
            </label>
            <AmountInput
              id="withdraw-remote"
              value={amount}
              onChange={setAmount}
              unit={row?.collateral.symbol ?? ''}
              onMax={() => row && setAmount(toInput(maxOut, row.collateral.decimals))}
            />
            <div className="amount-estimate">
              Value <b>{money(usd, 2)}</b>
            </div>
            {overMax && row && (
              <p className="inline-error" role="alert">
                Amount exceeds {maxOut < row.balance ? 'what can leave while your debt stays within the borrow limit' : `your posted ${row.collateral.symbol}`}:
                at most {truncatedUnits(maxOut, row.collateral.decimals, 6)} {row.collateral.symbol}.
              </p>
            )}
          </div>
          <div className="form-section">
            <span className="field-label">03 / DELIVERY</span>
            <dl className="release-summary">
              <div>
                <dt>Arrives on</dt>
                <dd>
                  {spoke && <ChainLogo network={spoke.name} size={16} />} {spoke?.label ?? '—'}
                </dd>
              </div>
              <div>
                <dt>Recipient</dt>
                <dd>{address ? `${shortAddress(address)} (this wallet)` : '—'}</dd>
              </div>
              {valued && valued.debtUsd > 0 && (
                <div>
                  <dt>Health factor</dt>
                  <dd>
                    <b>{fmtHealth(valued.healthFactor)}</b> →{' '}
                    <b className={`tone-${Number.isFinite(hfAfter) ? healthStatus(hfAfter).tone : 'ok'}`}>{fmtHealth(hfAfter)}</b>
                  </dd>
                </div>
              )}
              <div>
                <dt>Arrival</dt>
                <dd>≈ {etaMin} min after the hub transaction</dd>
              </div>
            </dl>
          </div>
          <ConnectGate connected={isConnected}>
            <button className="button button--dark button--wide" onClick={withdraw} disabled={invalid || Boolean(busy)}>
              {busy ?? (
                <>
                  Release to {spoke?.label ?? 'the spoke'} <ArrowRight size={15} />
                </>
              )}
            </button>
          </ConnectGate>
          <div className="small-disclosure">
            <Shield size={14} /> The hub debits your collateral first, then sends a guardian-signed Wormhole RELEASE to the {spoke?.label ?? 'spoke'} gateway
            (Mezo is final at once). The Mezodot agent delivers it, and you can relay it yourself from Message lifecycle. Price updates and the Wormhole fee are
            attached to the transaction.
          </div>
        </>
      )}
    </section>
  );
}
