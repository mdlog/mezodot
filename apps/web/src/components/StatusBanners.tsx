import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RefreshCw, ShieldAlert, TriangleAlert, Wallet } from 'lucide-react';
import { useAccount } from 'wagmi';
import { PRICE_SYMBOLS } from '@mezodot/sdk';
import { CONFIG_ERRORS, HUB, HUB_DEPLOYED } from '../chain/env';
import { readError, useHubStatus, usePrices, useWalletBalances } from '../data/hooks';
import { Brand } from './ui';

/**
 * App-wide notices for the reads everything depends on, so a failing RPC or relay is named once, with a retry,
 * instead of every page silently showing zeros or loading forever.
 */
export function HubStatusBanner() {
  const hub = useHubStatus();
  if (!HUB_DEPLOYED || !hub.error) return null;
  return (
    <div className="status-banner status-banner--error" role="alert">
      <TriangleAlert size={15} />
      <span>
        <b>{hub.stale ? `Live data from ${HUB.label} paused.` : `Cannot read the hub contracts on ${HUB.label}.`}</b> {hub.error}.{' '}
        {hub.stale
          ? 'Showing the last values read; transactions may fail until it recovers.'
          : 'Markets, positions and actions are unavailable until it recovers.'}
      </span>
      <button onClick={hub.retry} disabled={hub.retrying}>
        <RefreshCw size={13} className={hub.retrying ? 'spin' : undefined} /> {hub.retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

/**
 * The connected wallet's hub balances could not be read (the hub itself can): what it can send is unknown, never
 * zero, so actions sized by it wait. Spoke balances report their own errors in place.
 */
export function BalancesBanner() {
  const { isConnected } = useAccount();
  const hub = useHubStatus();
  const balances = useWalletBalances();
  if (!isConnected || hub.error || !balances.error || balances.data) return null;
  return (
    <div className="status-banner status-banner--warn" role="status">
      <Wallet size={15} />
      <span>
        <b>Cannot read your wallet balances on {HUB.label}.</b> {readError(balances.error)}. Until they load, amounts cannot be checked against your wallet, so
        supplying, posting and repaying wait.
      </span>
      <button onClick={() => void balances.refetch()} disabled={balances.isFetching}>
        <RefreshCw size={13} className={balances.isFetching ? 'spin' : undefined} /> {balances.isFetching ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

/** The agent relay supplies the pull prices (Supra proofs) that ETH and USDC collateral need. */
export function RelayBanner() {
  const prices = usePrices().data;
  const queryClient = useQueryClient();
  if (!prices?.relayError) return null;
  const missing = PRICE_SYMBOLS.filter((s) => prices.usable[s] === undefined);
  return (
    <div className="status-banner status-banner--warn" role="status">
      <CloudOff size={15} />
      <span>
        <b>Price relay unreachable.</b> No fresh {missing.length > 0 ? missing.join(' / ') : 'pull'} price from the Mezodot agent ({prices.relayError}). That
        collateral counts as $0 toward borrowing until it is back; repaying and closing positions still work.
      </span>
      <button onClick={() => void queryClient.refetchQueries({ queryKey: ['pullPrices'] })}>
        <RefreshCw size={13} /> Retry
      </button>
    </div>
  );
}

/** In place of content waiting on the hub read: a loading line, or why it failed with a retry. */
export function HubPending({ what = 'on-chain data' }: { what?: string }) {
  const hub = useHubStatus();
  if (!HUB_DEPLOYED) return <p className="muted-note">Contracts are not deployed on {HUB.label} yet.</p>;
  if (hub.error) {
    return (
      <p className="inline-error" role="alert">
        Cannot load {what}: {hub.error}.{' '}
        <button className="text-link" onClick={hub.retry} disabled={hub.retrying}>
          {hub.retrying ? 'Retrying…' : 'Retry'}
        </button>
      </p>
    );
  }
  return <p className="muted-note">Loading {what}…</p>;
}

/** A failed read with a retry, e.g. wallet balances. */
export function QueryError({ error, what, onRetry }: { error: unknown; what: string; onRetry: () => void }) {
  return (
    <p className="inline-error" role="alert">
      Could not read {what}: {readError(error)}.{' '}
      <button className="text-link" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

/** Blocks a build whose configuration would send visitors to the wrong services (see chain/config.ts). */
export function ConfigErrorScreen() {
  return (
    <main className="config-error">
      <Brand />
      <section className="panel empty-state empty-state--panel" role="alert">
        <ShieldAlert size={23} />
        <b>This copy of Mezodot is not configured for public use</b>
        <span>It would send your browser to services that are not there, so it stays closed. If you run this site, rebuild it with:</span>
        <ul>
          {CONFIG_ERRORS.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
