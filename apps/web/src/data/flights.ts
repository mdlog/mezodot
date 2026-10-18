import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { TransactionReceiptNotFoundError, isAddressEqual, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { fetchSignedVaa, spokeGatewayAbi, vaaDigest, wormholeAdapterAbi, type NetworkName } from '@mezodot/sdk';
import { AGENT_URL, ENV_NAME, HUB, SPOKES, networkByName, type HubInfo, type SpokeInfo } from '../chain/env';
import type { ActivityItem } from './activity';

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
    typeof x.createdAt === 'number'
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
 * another device, cleared storage, or a page reloaded before the receipt arrived.
 */
export function recoverFlights(items: readonly ActivityItem[], store: FlightStore, nowMs: number, deployments: Deployments = CURRENT): Flight[] {
  const known = new Set([...store.flights.map((f) => f.id), ...store.dismissed]);
  const knownTx = new Set(store.flights.map((f) => f.txHash.toLowerCase()));
  const out: Flight[] = [];
  for (const item of items) {
    const m = item.message;
    if (!m || item.timestamp === null || nowMs - item.timestamp > RECOVERY_WINDOW_MS) continue;
    const id = flightId(m.emitterChain, m.emitter, m.sequence);
    if (known.has(id) || knownTx.has(item.txHash.toLowerCase())) continue;
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
};

type AgentMessage = { id: string; status: string };

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
      const base = { vaa: null, delivered: false, relayer: null, sourcePending: false, failed: null };
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
      let agentStatus: string | null = null;
      if (api) {
        vaa = await fetchSignedVaa(api, flight.emitterChain, flight.emitter, BigInt(sequence)).catch(() => null);
      } else {
        // Devnet: the agent signs VAAs; ask it for the message status.
        const res = await fetch(`${AGENT_URL}/messages`).catch(() => null);
        const messages = res?.ok ? ((await res.json()) as AgentMessage[]) : [];
        agentStatus = messages.find((m) => m.id === `${flight.emitterChain}/${flight.emitter.toLowerCase()}/${sequence}`)?.status ?? null;
      }

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
      return {
        ...base,
        stage: delivered ? 4 : signed ? 2 : 1,
        vaa,
        delivered,
        sequence,
        relayer: api ? 'Mezodot agent or you (self-relay)' : 'Mezodot agent (devnet)',
      };
    },
  });
}
