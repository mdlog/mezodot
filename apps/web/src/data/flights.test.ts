import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from 'viem';
import { spokeGatewayAbi, wormholeAdapterAbi } from '@mezodot/sdk';
import { HUB, SPOKES } from '../chain/env';
import type { ActivityItem } from './activity';
import { flightId, isCurrentFlight, parseFlightStore, pendingFlightId, recoverFlights, sequenceFromLogs, serializeFlightStore, type Flight } from './flights';

const spoke = SPOKES.find((s) => s.deployment)!;
const gateway = spoke.deployment!.contracts.spokeGateway;
const adapter = HUB.deployment!.contracts.wormholeAdapter;
const OLD: Address = '0x125B0dBD6e759eA258B215212ECe4b4203Cd4b64';
const TX: Hex = `0x${'ab'.repeat(32)}`;

const deposit = (patch: Partial<Flight> = {}): Flight => ({
  id: flightId(spoke.wormholeChainId, gateway, 7n),
  direction: 'deposit',
  source: spoke.name,
  target: HUB.name,
  emitterChain: spoke.wormholeChainId,
  emitter: gateway,
  sequence: '7',
  txHash: TX,
  label: '1 WETH',
  createdAt: 1_000,
  ...patch,
});
const release = (patch: Partial<Flight> = {}): Flight => ({
  ...deposit(),
  id: flightId(HUB.wormholeChainId, adapter, 3n),
  direction: 'release',
  source: HUB.name,
  target: spoke.name,
  emitterChain: HUB.wormholeChainId,
  emitter: adapter,
  sequence: '3',
  ...patch,
});

describe('flights of the current deployment', () => {
  it('keeps messages whose emitter is the deployed gateway or adapter', () => {
    expect(isCurrentFlight(deposit())).toBe(true);
    expect(isCurrentFlight(release())).toBe(true);
    expect(isCurrentFlight(deposit({ emitter: gateway.toLowerCase() as Address }))).toBe(true);
  });

  it('drops messages of an earlier deployment or another environment, which could never be delivered', () => {
    expect(isCurrentFlight(deposit({ emitter: OLD }))).toBe(false);
    expect(isCurrentFlight(release({ emitter: OLD }))).toBe(false);
    expect(isCurrentFlight(deposit({ source: 'devnet-spoke' }))).toBe(false);
    expect(isCurrentFlight(release({ target: 'devnet-spoke' }))).toBe(false);
    expect(isCurrentFlight(deposit({ emitterChain: 1 }))).toBe(false);
  });
});

describe('flight storage', () => {
  it('reads valid current flights and dismissals, skipping junk and old deployments', () => {
    const raw = JSON.stringify({ flights: [deposit(), deposit({ id: 'old', emitter: OLD }), { nope: true }, null], dismissed: ['a', 3] });
    expect(parseFlightStore(raw, null)).toEqual({ flights: [deposit()], dismissed: ['a'] });
  });

  it('migrates v1 flights once, and survives corrupt storage', () => {
    expect(parseFlightStore(null, JSON.stringify([release(), release({ emitter: OLD })]))).toEqual({ flights: [release()], dismissed: [] });
    // Once a v2 store exists the shared v1 key is ignored.
    expect(parseFlightStore(JSON.stringify({ flights: [], dismissed: [] }), JSON.stringify([release()])).flights).toEqual([]);
    expect(parseFlightStore('{not json', '[[')).toEqual({ flights: [], dismissed: [] });
  });

  it('keeps pending flights (sequence not known yet) across reloads', () => {
    const pending = deposit({ id: pendingFlightId(TX), sequence: null });
    expect(parseFlightStore(serializeFlightStore({ flights: [pending], dismissed: [] }), null).flights).toEqual([pending]);
  });

  it('caps what it writes', () => {
    const many = Array.from({ length: 30 }, (_, i) => deposit({ id: `f${i}` }));
    const dismissed = Array.from({ length: 300 }, (_, i) => `d${i}`);
    const stored = JSON.parse(serializeFlightStore({ flights: many, dismissed })) as { flights: Flight[]; dismissed: string[] };
    expect(stored.flights).toHaveLength(20);
    expect(stored.dismissed).toHaveLength(200);
    expect(stored.dismissed[stored.dismissed.length - 1]).toBe('d299');
  });
});

describe('recovering flights from on-chain events', () => {
  const now = 10 * 3600_000;
  const item = (patch: Partial<ActivityItem> = {}): ActivityItem => ({
    id: 'x',
    kind: 'Cross-chain',
    network: spoke.name,
    asset: 'WETH',
    amount: 10n ** 18n,
    decimals: 18,
    detail: '',
    txHash: TX,
    blockNumber: 1n,
    timestamp: now - 60_000,
    message: { direction: 'deposit', target: HUB.name, emitterChain: spoke.wormholeChainId, emitter: gateway, sequence: '7', label: '1.0000 WETH from Base' },
    ...patch,
  });

  it('rebuilds a recent message the browser is not tracking', () => {
    const [flight] = recoverFlights([item()], { flights: [], dismissed: [] }, now);
    expect(flight).toMatchObject({ id: flightId(spoke.wormholeChainId, gateway, 7n), sequence: '7', recovered: true, createdAt: now - 60_000 });
  });

  it('skips tracked, dismissed, old and foreign messages', () => {
    const empty = { flights: [], dismissed: [] };
    expect(recoverFlights([item()], { flights: [deposit()], dismissed: [] }, now)).toEqual([]);
    expect(recoverFlights([item()], { flights: [], dismissed: [flightId(spoke.wormholeChainId, gateway, 7n)] }, now)).toEqual([]);
    // Recorded at signing (sequence not known yet): the same transaction is not added twice.
    expect(recoverFlights([item()], { flights: [deposit({ id: pendingFlightId(TX), sequence: null })], dismissed: [] }, now)).toEqual([]);
    expect(recoverFlights([item({ timestamp: now - 25 * 3600_000 })], empty, now)).toEqual([]);
    expect(recoverFlights([item({ timestamp: null })], empty, now)).toEqual([]);
    expect(recoverFlights([item({ message: undefined })], empty, now)).toEqual([]);
    expect(recoverFlights([item({ message: { ...item().message!, emitter: OLD } })], empty, now)).toEqual([]);
  });
});

describe('sequence from a source receipt', () => {
  const log = (abi: typeof spokeGatewayAbi | typeof wormholeAdapterAbi, eventName: 'Deposited' | 'ReleaseSent', args: Record<string, unknown>, data: Hex) =>
    ({
      address: gateway,
      topics: encodeEventTopics({ abi, eventName, args } as Parameters<typeof encodeEventTopics>[0]),
      data,
      blockHash: null,
      blockNumber: null,
      logIndex: null,
      transactionHash: null,
      transactionIndex: null,
      removed: false,
    }) as unknown as Log;

  it('reads the Deposited or ReleaseSent sequence', () => {
    const deposited = log(spokeGatewayAbi, 'Deposited', { sequence: 42n, account: gateway, token: gateway }, encodeAbiParameters([{ type: 'uint256' }], [5n]));
    expect(sequenceFromLogs({ direction: 'deposit' }, [deposited])).toBe('42');
    const sent = log(
      wormholeAdapterAbi,
      'ReleaseSent',
      { sequence: 9n, chainId: spoke.wormholeChainId },
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, 1n]),
    );
    expect(sequenceFromLogs({ direction: 'release' }, [sent])).toBe('9');
    expect(sequenceFromLogs({ direction: 'deposit' }, [sent])).toBeNull();
  });
});
