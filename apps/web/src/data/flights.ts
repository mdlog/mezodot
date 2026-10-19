import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { TransactionReceiptNotFoundError, getAbiItem, isAddress, isAddressEqual, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { fetchSignedVaa, spokeGatewayAbi, vaaDigest, wormholeAdapterAbi, type NetworkName } from '@mezodot/sdk';
import { AGENT_URL, ENV_NAME, HUB, SPOKES, networkByName, type HubInfo, type SpokeInfo } from '../chain/env';
import type { ActivityItem } from './activity';
import type { SpokeClaim } from './claims';
import { spokeHistoryStart } from './incremental';

/** A cross-chain message the user started, tracked until delivered. */
export type Flight = {
  /** flightId(...) once the sequence is known; pendingFlightId(txHash) before. */
  id: string;
  direction: 'deposit' | 'release';
  source: NetworkName;
  target: NetworkName;
  emitterChain: number;
  emitter: Address;
  /** Wormhole sequence (bigint as string for JSON storage); null until the source receipt has been read. */
  sequence: string | null;
  txHash: Hex;
  label: string;
  createdAt: number;
  /** Rebuilt from on-chain events (another device, cleared storage) rather than started in this browser. */
  recovered?: boolean;
  /**
   * The wallet that sent it: a flight is shown only while that wallet is connected. Absent on flights stored before
   * flights carried their sender, until that account's own on-chain events claim them (see unclaimedOwnFlights).
   */
  account?: Address;
};

export const flightId = (emitterChain: number, emitter: Address, sequence: bigint | string): string => `${emitterChain}/${emitter.toLowerCase()}/${sequence}`;
export const pendingFlightId = (txHash: Hex): string => `tx/${txHash.toLowerCase()}`;

/** Flights and the ids the user dismissed (so recovery does not bring them back), per environment. */
export type FlightStore = { flights: Flight[]; dismissed: string[] };

export const FLIGHTS_KEY = `mezodot-flights-v2:${ENV_NAME}`;
/** Shared by every environment served from the same origin; read once for migration. */
export const LEGACY_FLIGHTS_KEY = 'mezodot-flights-v1';
const MAX_FLIGHTS = 20;
const MAX_DISMISSED = 200;

export type Deployments = { hub: HubInfo; spokes: SpokeInfo[] };
const CURRENT: Deployments = { hub: HUB, spokes: SPOKES };

/**
 * Whether `flight` can still be delivered by the contracts this app talks to: both ends are networks of
 * this environment and the emitter is the deployed gateway or adapter. Messages of an earlier deployment
 * would be rejected (UnknownEmitter) and could never show as delivered.
 */
export function isCurrentFlight(flight: Flight, { hub, spokes }: Deployments = CURRENT): boolean {
  if (!hub.deployment) return false;
  if (flight.direction === 'deposit') {
    const spoke = spokes.find((s) => s.name === flight.source);
    return Boolean(
      spoke?.deployment &&
      flight.target === hub.name &&
      flight.emitterChain === spoke.wormholeChainId &&
      isAddressEqual(flight.emitter, spoke.deployment.contracts.spokeGateway),
    );
  }
  return (
    flight.source === hub.name &&
    flight.emitterChain === hub.wormholeChainId &&
    isAddressEqual(flight.emitter, hub.deployment.contracts.wormholeAdapter) &&
    spokes.some((s) => s.name === flight.target && s.deployment)
  );
}

const isFlight = (f: unknown): f is Flight => {
  const x = f as Partial<Flight> | null;
  return (
    !!x &&
    typeof x.id === 'string' &&
    (x.direction === 'deposit' || x.direction === 'release') &&
    typeof x.source === 'string' &&
    typeof x.target === 'string' &&
    typeof x.emitterChain === 'number' &&
    typeof x.emitter === 'string' &&
    (x.sequence === null || typeof x.sequence === 'string') &&
    typeof x.txHash === 'string' &&
    typeof x.label === 'string' &&
    typeof x.createdAt === 'number' &&
    (x.account === undefined || (typeof x.account === 'string' && isAddress(x.account)))
  );
};

const parse = (raw: string | null): unknown => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/** Reads the store, keeping only flights of the current deployment; migrates v1 flights when there is no v2 store. */
export function parseFlightStore(raw: string | null, legacyRaw: string | null, deployments: Deployments = CURRENT): FlightStore {
  const stored = parse(raw) as Partial<FlightStore> | null;
  const candidates = stored ? stored.flights : parse(legacyRaw);
  const flights = (Array.isArray(candidates) ? (candidates as unknown[]) : []).filter(isFlight).filter((f) => isCurrentFlight(f, deployments));
  const dismissed = Array.isArray(stored?.dismissed) ? stored.dismissed.filter((d): d is string => typeof d === 'string') : [];
  return { flights, dismissed };
}

export const serializeFlightStore = (store: FlightStore): string =>
  JSON.stringify({ flights: store.flights.slice(0, MAX_FLIGHTS), dismissed: store.dismissed.slice(-MAX_DISMISSED) });

/** How far back on-chain events are turned into flights the browser is not tracking. */
export const RECOVERY_WINDOW_MS = 24 * 3600_000;

/**
 * Flights for recent cross-chain events of the account that the store does not know about: a lock sent from
 * another device, cleared storage, or a page reloaded before the receipt arrived. A flight the user stopped
 * tracking stays dismissed under either id: the sequence id, or the pending id (its transaction) when it was
 * dismissed before its receipt told the sequence.
 */
export function recoverFlights(items: readonly ActivityItem[], store: FlightStore, nowMs: number, deployments: Deployments = CURRENT): Flight[] {
  const known = new Set([...store.flights.map((f) => f.id), ...store.dismissed]);
  const knownTx = new Set(store.flights.map((f) => f.txHash.toLowerCase()));
  const out: Flight[] = [];
  for (const item of items) {
    const m = item.message;
    if (!m || item.timestamp === null || nowMs - item.timestamp > RECOVERY_WINDOW_MS) continue;
    const id = flightId(m.emitterChain, m.emitter, m.sequence);
    if (known.has(id) || known.has(pendingFlightId(item.txHash)) || knownTx.has(item.txHash.toLowerCase())) continue;
    const flight: Flight = {
      id,
      direction: m.direction,
      source: item.network,
      target: m.target,
      emitterChain: m.emitterChain,
      emitter: m.emitter,
      sequence: m.sequence,
      txHash: item.txHash,
      label: m.label,
      createdAt: item.timestamp,
      recovered: true,
    };
    if (!isCurrentFlight(flight, deployments)) continue;
    known.add(id);
    out.push(flight);
  }
  return out;
}

/** The flights `account` sent; none without a connected account (the store is shared by everyone using this browser). */
export const flightsOf = (flights: readonly Flight[], account: Address | undefined): Flight[] =>
  account ? flights.filter((f) => f.account !== undefined && isAddressEqual(f.account, account)) : [];

/**
 * Stored flights without a sender that the connected account's own on-chain events show it sent (flights saved before
 * flights carried their account): the ids to stamp with that account. A flight no event of the account matches stays
 * unclaimed, and so stays hidden from every account.
 */
export function unclaimedOwnFlights(items: readonly ActivityItem[], flights: readonly Flight[]): string[] {
  const ids = new Set<string>();
  const txs = new Set<string>();
  for (const item of items) {
    if (!item.message) continue;
    ids.add(flightId(item.message.emitterChain, item.message.emitter, item.message.sequence));
    ids.add(pendingFlightId(item.txHash));
    txs.add(item.txHash.toLowerCase());
  }
  return flights.filter((f) => !f.account && (ids.has(f.id) || txs.has(f.txHash.toLowerCase()))).map((f) => f.id);
}

/** The Wormhole sequence a source transaction emitted, from its receipt logs. */
export function sequenceFromLogs(flight: Pick<Flight, 'direction'>, logs: Parameters<typeof parseEventLogs>[0]['logs']): string | null {
  if (flight.direction === 'deposit') {
    const [event] = parseEventLogs({ abi: spokeGatewayAbi, logs, eventName: 'Deposited' });
    return event ? event.args.sequence.toString() : null;
  }
  const [event] = parseEventLogs({ abi: wormholeAdapterAbi, logs, eventName: 'ReleaseSent' });
  return event ? event.args.sequence.toString() : null;
}

export type FlightStatus = {
  /** 1 locked/sent on source · 2 guardians signed (VAA) · 3 delivered on target · 4 usable */
  stage: 1 | 2 | 3 | 4;
  vaa: Hex | null;
  delivered: boolean;
  /** Who is expected to deliver: the agent relayer or the user (self-relay). */
  relayer: string | null;
  /** Read from the source receipt for a flight recorded before it was mined. */
  sequence: string | null;
  /** The source transaction is still pending (it may have been dropped). */
  sourcePending: boolean;
  /** The source transaction reverted: no message was sent. */
  failed: string | null;
  /** How a delivered release ended, when the agent delivered it (devnet); else see useReleaseOutcome. */
  outcome: ReleaseOutcome | null;
};

/** A message as the agent's /messages lists it: `deferred` once a release it delivered was held for a claim. */
type AgentMessage = { id: string; status: string; deliveredTx?: string; deferred?: { token: Address } };

// --- Delivered releases: sent to the recipient, or held by the gateway ---------------------------------------

/** How SpokeGateway.receiveMessage ended for one RELEASE: the transfer reached the recipient, or `token` waits for a claim. */
export type ReleaseOutcome = { deferred: false } | { deferred: true; token: Address };

const RELEASE_EVENTS = [getAbiItem({ abi: spokeGatewayAbi, name: 'Released' }), getAbiItem({ abi: spokeGatewayAbi, name: 'ReleaseDeferred' })] as const;

/**
 * How the delivery of the RELEASE with VAA digest `digest` ended on `gateway`: the delivery emits Released, or
 * ReleaseDeferred when the token transfer failed, both indexed by that digest. Scans back from `latest` in
 * `chunk`-block ranges (public RPCs cap eth_getLogs), newest first since deliveries are usually recent, and stops at
 * the first match; null when neither event is in [floor, latest].
 */
export async function findReleaseOutcome(
  client: Pick<PublicClient, 'getLogs'>,
  gateway: Address,
  digest: Hex,
  { latest, floor, chunk }: { latest: bigint; floor: bigint; chunk: bigint },
): Promise<ReleaseOutcome | null> {
  for (let to = latest; to >= floor; to -= chunk) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    const logs = await client.getLogs({ address: gateway, events: RELEASE_EVENTS, fromBlock: from, toBlock: to });
    const hit = logs.find((log) => log.args.vaaHash?.toLowerCase() === digest.toLowerCase());
    if (hit) return hit.eventName === 'ReleaseDeferred' && hit.args.token ? { deferred: true, token: hit.args.token } : { deferred: false };
  }
  return null;
}

/** Outcomes found so far, per spoke and digest: a delivered release never changes, so each is looked up once. */
const OUTCOMES = new Map<string, ReleaseOutcome>();
/** Scans that found nothing, per release: past OUTCOME_SCANS a global refetch answers from here instead of rescanning. */
const MISSES = new Map<string, number>();
/** Scans of the window before an outcome that was not found is left unknown, and the pause between them. */
const OUTCOME_SCANS = 3;
const OUTCOME_RESCAN_MS = 15_000;

/**
 * The outcome of a delivered release flight, read from its gateway's events (see findReleaseOutcome) over the window
 * the activity view reads. Enable it only when it can matter: while the account has something to claim on that spoke.
 */
export function useReleaseOutcome(flight: Pick<Flight, 'direction' | 'target'>, vaa: Hex | null, enabled: boolean) {
  const spoke = SPOKES.find((s) => s.name === flight.target);
  const client = usePublicClient({ chainId: spoke?.chain.id }) as PublicClient | undefined;
  const digest = vaa ? vaaDigest(vaa) : null;
  return useQuery({
    queryKey: ['releaseOutcome', flight.target, digest],
    enabled: Boolean(enabled && flight.direction === 'release' && digest && spoke?.deployment && client),
    staleTime: Infinity,
    // Not found may be an RPC a block behind the one that reported the delivery: look twice more, then stop.
    refetchInterval: (q) => (q.state.data === null && q.state.dataUpdateCount < OUTCOME_SCANS ? OUTCOME_RESCAN_MS : false),
    queryFn: async (): Promise<ReleaseOutcome | null> => {
      const key = `${flight.target}:${digest}`;
      const known = OUTCOMES.get(key);
      if (known) return known;
      if ((MISSES.get(key) ?? 0) >= OUTCOME_SCANS) return null;
      const latest = await client!.getBlockNumber();
      const outcome = await findReleaseOutcome(client!, spoke!.deployment!.contracts.spokeGateway, digest!, {
        latest,
        floor: spokeHistoryStart(latest, BigInt(spoke!.deployment!.startBlock), spoke!.maxLogRange),
        chunk: spoke!.maxLogRange,
      });
      if (outcome) OUTCOMES.set(key, outcome);
      else MISSES.set(key, (MISSES.get(key) ?? 0) + 1);
      return outcome;
    },
  });
}

/**
 * Whether a release flight's tokens wait in the spoke gateway for a claim: its own delivery was deferred and that
 * token is still claimable there. Another release's claim on the same spoke says nothing about this one, and a
 * deferred release that was claimed since is done.
 */
export function releaseHeld(
  flight: Pick<Flight, 'direction' | 'target'>,
  delivered: boolean,
  outcome: ReleaseOutcome | null | undefined,
  claims: readonly Pick<SpokeClaim, 'spoke' | 'token'>[] | undefined,
): boolean {
  if (flight.direction !== 'release' || !delivered || !outcome?.deferred) return false;
  return (claims ?? []).some((c) => c.spoke.name === flight.target && isAddressEqual(c.token, outcome.token));
}

/**
 * Tracks one Wormhole message: the source receipt (for flights recorded at signing), VAA availability from
 * Wormholescan (testnet) or the agent (devnet, where VAAs are signed locally), and delivery via the target
 * contract's replay guard.
 */
export function useFlightStatus(flight: Flight) {
  const source = networkByName(flight.source);
  const target = networkByName(flight.target);
  const sourceClient = usePublicClient({ chainId: source?.chain.id }) as PublicClient | undefined;
  const targetClient = usePublicClient({ chainId: target?.chain.id }) as PublicClient | undefined;
  const api = source?.wormholescanApi ?? null;

  return useQuery({
    queryKey: ['flight', flight.id, flight.sequence],
    refetchInterval: (q) => (q.state.data?.delivered || q.state.data?.failed ? false : 6_000),
    enabled: Boolean(source && target && sourceClient && targetClient && isCurrentFlight(flight)),
    queryFn: async (): Promise<FlightStatus> => {
      const base = { vaa: null, delivered: false, relayer: null, sourcePending: false, failed: null, outcome: null };
      let sequence = flight.sequence;
      if (sequence === null) {
        const receipt = await sourceClient!.getTransactionReceipt({ hash: flight.txHash }).catch((err: unknown) => {
          if (err instanceof TransactionReceiptNotFoundError) return null;
          throw err;
        });
        if (!receipt) return { ...base, stage: 1, sequence: null, sourcePending: true };
        if (receipt.status !== 'success') return { ...base, stage: 1, sequence: null, failed: 'The source transaction reverted: no message was sent' };
        sequence = sequenceFromLogs(flight, receipt.logs);
        if (sequence === null) return { ...base, stage: 1, sequence: null, failed: 'The source transaction sent no Wormhole message' };
      }

      let vaa: Hex | null = null;
      let agent: AgentMessage | null = null;
      if (api) {
        vaa = await fetchSignedVaa(api, flight.emitterChain, flight.emitter, BigInt(sequence)).catch(() => null);
      } else {
        // Devnet: the agent signs VAAs; ask it for the message status.
        const res = await fetch(`${AGENT_URL}/messages`).catch(() => null);
        const messages = res?.ok ? ((await res.json()) as AgentMessage[]) : [];
        agent = messages.find((m) => m.id === `${flight.emitterChain}/${flight.emitter.toLowerCase()}/${sequence}`) ?? null;
      }
      const agentStatus = agent?.status ?? null;

      let delivered = agentStatus === 'delivered';
      if (vaa) {
        const digest = vaaDigest(vaa);
        const spoke = SPOKES.find((s) => s.name === flight.target);
        delivered =
          flight.direction === 'deposit'
            ? await targetClient!.readContract({
                address: HUB.deployment!.contracts.wormholeAdapter,
                abi: wormholeAdapterAbi,
                functionName: 'isConsumed',
                args: [digest],
              })
            : await targetClient!.readContract({
                address: spoke!.deployment!.contracts.spokeGateway,
                abi: spokeGatewayAbi,
                functionName: 'isConsumed',
                args: [digest],
              });
      }
      const signed = Boolean(vaa) || agentStatus === 'ready' || delivered;
      // The agent knows how a release it delivered ended (it reads its own delivery receipt).
      const outcome: ReleaseOutcome | null =
        flight.direction !== 'release' || agentStatus !== 'delivered'
          ? null
          : agent?.deferred
            ? { deferred: true, token: agent.deferred.token }
            : agent?.deliveredTx
              ? { deferred: false }
              : null;
      return {
        ...base,
        stage: delivered ? 4 : signed ? 2 : 1,
        vaa,
        delivered,
        sequence,
        relayer: api ? 'Mezodot agent or you (self-relay)' : 'Mezodot agent (devnet)',
        outcome,
      };
    },
  });
}
