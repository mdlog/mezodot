import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  HttpRequestError,
  InvalidParamsRpcError,
  RpcRequestError,
  TimeoutError,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  sliceHex,
  type Hex,
} from 'viem';
import { MessageType, encodePayload, signDevVaa, spokeGatewayAbi, toBytes32, vaaBody } from '@mezodot/sdk';
import { FINALIZED_RETRY_MS, Relayer, markSeen, messageId, releaseDeferred, stuckAfterMs, vaaHash, vaaPollDelayMs, type RelayMessage } from '../src/relayer';
import { JsonStore } from '../src/store';
import { TxSender, type SendOptions } from '../src/tx';
import { scriptedChain } from './chain';

const GUARDIAN = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';
const GATEWAY = '0x00000000000000000000000000000000000000ab';
const OLD_GATEWAY = '0x00000000000000000000000000000000000000a0';
const ADAPTER = '0x00000000000000000000000000000000000000ad';
const OLD_ADAPTER = '0x00000000000000000000000000000000000000ac';
const KEEPER_GATEWAY = '0x00000000000000000000000000000000000000ee';
const KEEPER = '0x000000000000000000000000000000000000beef';
const VAA_API = 'http://vaa.test';

const stateDir = () => mkdtempSync(join(tmpdir(), 'mezodot-relayer-'));

/** A delivery sender that records requests and answers with `receipt`. */
function fakeSender(receipt: Record<string, unknown> = {}, fail?: Error) {
  const sent: { request: Record<string, unknown>; options: SendOptions }[] = [];
  const sender = {
    address: KEEPER,
    send: async (request: Record<string, unknown>, options: SendOptions) => {
      sent.push({ request, options });
      if (fail) throw fail;
      return { hash: `0x${'22'.repeat(32)}`, receipt: { status: 'success', logs: [], ...receipt }, gas: 0n, nonce: 0 };
    },
  };
  return { sender, sent };
}

type CtxOptions = {
  dir?: string;
  hubClient?: unknown;
  spokeClient?: unknown;
  hubSender?: unknown;
  spokeSender?: unknown;
  vaaApis?: Record<string, string[]>;
  logs?: string[];
  hubNetwork?: string;
  spokeNetwork?: string;
  pollMs?: number;
};

/** Devnet-shaped context (agent-signed VAAs) unless `vaaApis` names guardian sources for a network. */
const relayCtx = (o: CtxOptions = {}) => ({
  config: { stateDir: o.dir ?? stateDir(), env: 'devnet', devGuardianKey: null, vaaApis: o.vaaApis ?? {}, pollMs: o.pollMs },
  hub: {
    network: o.hubNetwork ?? 'devnet-hub',
    client: o.hubClient ?? { getBlockNumber: async () => 0n, getContractEvents: async () => [], readContract: async () => false },
    wallet: null,
    sender: o.hubSender ?? null,
    deployment: { startBlock: 0, wormholeChainId: 50, contracts: { wormholeAdapter: ADAPTER, keeperGateway: KEEPER_GATEWAY } },
  },
  spokes: [
    {
      network: o.spokeNetwork ?? 'base-sepolia',
      client: o.spokeClient ?? { getBlockNumber: async () => 0n, getContractEvents: async () => [], readContract: async () => false },
      wallet: null,
      sender: o.spokeSender ?? null,
      deployment: { startBlock: 0, wormholeChainId: 10004, contracts: { spokeGateway: GATEWAY } },
    },
  ],
  log: (_scope: string, message: string) => o.logs?.push(message),
});

const deposit = (over: Partial<RelayMessage> = {}): RelayMessage => ({
  id: 'm',
  direction: 'deposit',
  source: 'base-sepolia',
  target: 'devnet-hub',
  emitterChain: 10004,
  emitter: GATEWAY,
  sequence: 1n,
  txHash: '0x01',
  blockNumber: 1n,
  status: 'waiting_vaa',
  attempts: 0,
  observedAt: 0,
  ...over,
});

/** A RELEASE from the hub adapter to the base-sepolia gateway. */
const release = (over: Partial<RelayMessage> = {}): RelayMessage =>
  deposit({ direction: 'release', source: 'devnet-hub', target: 'base-sepolia', emitterChain: 50, emitter: ADAPTER, ...over });

/** A DEPOSIT VAA from the spoke gateway, addressed to `target` (the hub adapter unless a replaced one is named). */
const depositVaa = (sequence: bigint, emitter: Hex = GATEWAY, target: Hex = ADAPTER) =>
  signDevVaa(GUARDIAN, {
    timestamp: 1,
    nonce: 0,
    emitterChain: 10004,
    emitter,
    sequence,
    consistencyLevel: 1,
    payload: encodePayload({
      msgType: MessageType.DEPOSIT,
      nonce: sequence,
      targetChain: 50,
      target: toBytes32(target),
      account: toBytes32(KEEPER),
      token: toBytes32('0x4200000000000000000000000000000000000006'),
      amount: 10n ** 15n,
    }),
  });

/** A RELEASE VAA from the hub adapter, addressed to the base-sepolia gateway unless another one is named. */
const releaseVaa = (sequence: bigint, target: Hex = GATEWAY) =>
  signDevVaa(GUARDIAN, {
    timestamp: 1,
    nonce: 0,
    emitterChain: 50,
    emitter: ADAPTER,
    sequence,
    consistencyLevel: 1,
    payload: encodePayload({
      msgType: MessageType.RELEASE,
      nonce: sequence,
      targetChain: 10004,
      target: toBytes32(target),
      account: toBytes32(KEEPER),
      token: toBytes32('0x4200000000000000000000000000000000000006'),
      amount: 10n ** 15n,
    }),
  });

/** Wormholescan-style /v1/signed_vaa responses from a map of sequence → VAA (404 for the rest). */
const vaaSource = (vaas: Map<bigint, Hex>, asked: bigint[] = []) =>
  (async (url: string) => {
    const sequence = BigInt(url.split('/').pop()!);
    asked.push(sequence);
    const vaa = vaas.get(sequence);
    if (!vaa) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ vaaBytes: Buffer.from(vaa.slice(2), 'hex').toString('base64') }));
  }) as unknown as typeof fetch;

describe('relayer primitives', () => {
  it('vaaHash equals keccak(keccak(body)) — the contracts replay key', async () => {
    const m = {
      timestamp: 1,
      nonce: 0,
      emitterChain: 10004,
      emitter: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82',
      sequence: 3n,
      consistencyLevel: 1,
      payload: '0xbeef' as Hex,
    } as const;
    const vaa = await signDevVaa(GUARDIAN, m);
    expect(vaaHash(vaa)).toBe(keccak256(keccak256(vaaBody(m))));
    // Same body after the 72-byte header+signature.
    expect(sliceHex(vaa, 72)).toBe(vaaBody(m));
  });

  it('message ids are case-insensitive on the emitter', () => {
    expect(messageId(50, '0xABCDEF0000000000000000000000000000000001', 7n)).toBe(messageId(50, '0xabcdef0000000000000000000000000000000001', 7n));
  });

  it('store persists bigints across reloads', () => {
    const path = join(stateDir(), 's.json');
    const a = new JsonStore<{ cursor: bigint | null }>(path, { cursor: null });
    a.update((s) => {
      s.cursor = 123n;
    });
    const b = new JsonStore<{ cursor: bigint | null }>(path, { cursor: null });
    expect(b.get().cursor).toBe(123n);
  });

  it('a read-only store never writes and follows the file it shares', async () => {
    const path = join(stateDir(), 's.json');
    const writer = new JsonStore<{ n: number }>(path, { n: 0 });
    writer.update((s) => void (s.n = 1));
    const reader = new JsonStore<{ n: number }>(path, { n: 0 }, { readOnly: true });
    reader.update((s) => void (s.n = 99)); // in memory only
    expect(JSON.parse(readFileSync(path, 'utf8')).n).toBe(1);
    writer.update((s) => void (s.n = 7));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2_000); // past the reload check interval
      expect(reader.get().n).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks per-emitter sequences and reports the gaps below the highest one seen', () => {
    const tracks = {};
    for (const s of [0n, 1n, 3n, 6n]) markSeen(tracks, 'e', s);
    expect(tracks).toEqual({ e: { next: 2n, ahead: [3n, 6n] } });
    markSeen(tracks, 'e', 2n);
    expect(tracks).toEqual({ e: { next: 4n, ahead: [6n] } });
    markSeen(tracks, 'e', 1n); // already seen: no change
    expect(tracks).toEqual({ e: { next: 4n, ahead: [6n] } });
  });

  it('backs signed-VAA lookups off from 10 s to a minute, and calls a message stuck after 3× source finality', () => {
    expect(vaaPollDelayMs(1)).toBe(10_000);
    expect(vaaPollDelayMs(2)).toBe(15_000);
    expect(vaaPollDelayMs(20)).toBe(60_000);
    expect(stuckAfterMs('base-sepolia')).toBe(3 * 20 * 60_000);
  });
});

describe('relayer retry policy (final review M1)', () => {
  it('backs off exponentially and is capped', async () => {
    const { retryDelayMs, RETRY_BASE_MS, RETRY_MAX_MS } = await import('../src/relayer');
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(3)).toBe(RETRY_BASE_MS * 4);
    expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
  });

  it('never gives up, skips messages still in backoff, and isolates failing sources', async () => {
    const logs: string[] = [];
    const failingClient = { getBlockNumber: async () => Promise.reject(new Error('rpc down')) };
    let now = 1_000_000;
    const relayer = new Relayer(relayCtx({ hubClient: failingClient, spokeClient: failingClient, logs }) as never, fetch, () => now);
    const attempted: string[] = [];
    (relayer as unknown as { advance: (m: { id: string }) => Promise<void> }).advance = async (m) => {
      attempted.push(m.id);
      throw new Error('transient');
    };
    relayer.store.update((s) => {
      s.messages['a'] = deposit({ id: 'a' });
    });

    for (let i = 0; i < 20; i++) {
      await relayer.tick(); // scan failures must not throw
      now += 60 * 60_000; // jump past any backoff
    }
    const m = relayer.store.get().messages['a'];
    expect(m.status).not.toBe('failed');
    expect(m.attempts).toBe(20);
    expect(relayer.pending().map((x) => x.id)).toEqual(['a']);
    // Both sources failed on every tick; each failure is logged once and tracked for /health.
    expect(logs.filter((l) => l === 'scan failed')).toHaveLength(2);
    expect(relayer.failingScans().map((f) => [f.network, f.since, f.error])).toEqual([
      ['base-sepolia', 1_000_000, 'rpc down'],
      ['devnet-hub', 1_000_000, 'rpc down'],
    ]);

    // Within the backoff window nothing is attempted.
    const before = attempted.length;
    await relayer.tick();
    now += 1;
    await relayer.tick();
    expect(attempted.length).toBe(before + 1);
  });
});

describe('relayer scanning and delivery (audit: agent)', () => {
  it('scans within the RPC block-range cap, shrinking on refusal and draining a backlog per tick', async () => {
    const calls: [bigint, bigint][] = [];
    // A custom RPC with a 100-block cap, below the 200 known for Base Sepolia's public endpoint.
    const spokeClient = {
      getBlockNumber: async () => 2_400n,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (toBlock - fromBlock + 1n > 100n) throw new Error('eth_getLogs is limited to a 100 range');
        calls.push([fromBlock, toBlock]);
        return fromBlock <= 1_234n && 1_234n <= toBlock ? [{ args: { sequence: 7n }, transactionHash: '0x' + '11'.repeat(32), blockNumber: 1_234n }] : [];
      },
    };
    const relayer = new Relayer(relayCtx({ spokeClient }) as never, fetch, () => 0);
    (relayer as unknown as { advance: () => Promise<void> }).advance = async () => {};
    await relayer.tick();
    expect(calls.every(([f, t]) => t - f + 1n <= 100n)).toBe(true);
    // Caught up in one tick; the cursor names the contract it scanned.
    expect(relayer.store.get().cursors['base-sepolia']).toEqual({ block: 2_401n, contract: GATEWAY });
    expect(relayer.messages().map((m) => m.sequence)).toEqual([7n]);
    expect(relayer.messages()[0].targetContract).toBe(ADAPTER);
  });

  it('does not shrink the window for errors unrelated to the block range, rate limiting included', async () => {
    const sizes: bigint[] = [];
    const errors = ['fetch failed: ECONNRESET', 'HTTP request failed. Status: 429 Too Many Requests', 'request limit reached'];
    const spokeClient = {
      getBlockNumber: async () => 10_000n,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        sizes.push(toBlock - fromBlock + 1n);
        throw new Error(errors[(sizes.length - 1) % errors.length]);
      },
    };
    const relayer = new Relayer(relayCtx({ spokeClient }) as never, fetch, () => 0);
    for (let i = 0; i < 3; i++) await relayer.tick();
    expect(sizes).toEqual([200n, 200n, 200n]); // one attempt per tick at the network's cap, no shrinking
  });

  it('a delivery whose transaction reverts is retried, not recorded as delivered', async () => {
    const { sender } = fakeSender({ status: 'reverted' });
    const relayer = new Relayer(relayCtx({ hubSender: sender }) as never, fetch, () => 0);
    const vaa = await depositVaa(1n);
    relayer.store.update((s) => {
      s.messages['m'] = deposit({ status: 'ready', vaa });
    });
    await relayer.tick();
    const m = relayer.store.get().messages['m'];
    expect(m.status).toBe('ready');
    expect(m.attempts).toBe(1);
    expect(m.lastError).toMatch(/reverted/);
  });

  it('a failed delivery keeps a fetched VAA "ready" instead of flipping back to waiting_vaa (relayer-status-regression)', async () => {
    const vaa = await depositVaa(1n);
    const { sender } = fakeSender({}, new Error('insufficient funds for gas * price + value'));
    const relayer = new Relayer(relayCtx({ hubSender: sender, vaaApis: { 'base-sepolia': [VAA_API] } }) as never, vaaSource(new Map([[1n, vaa]])), () => 0);
    relayer.store.update((s) => {
      s.messages['m'] = deposit();
    });
    await relayer.tick();
    const m = relayer.store.get().messages['m'];
    expect(m.vaa).toBe(vaa);
    expect(m.status).toBe('ready');
    expect(m.attempts).toBe(1);
    expect(m.lastError).toMatch(/insufficient funds/);
  });

  it('polls for a VAA with backoff while guardians have not signed, without counting failures', async () => {
    const asked: bigint[] = [];
    let now = 0;
    const relayer = new Relayer(relayCtx({ vaaApis: { 'base-sepolia': [VAA_API] } }) as never, vaaSource(new Map(), asked), () => now);
    relayer.store.update((s) => {
      s.messages['m'] = deposit();
    });
    await relayer.tick();
    await relayer.tick(); // still in its 10 s wait
    now += 10_001;
    await relayer.tick();
    expect(asked).toEqual([1n, 1n]);
    const m = relayer.store.get().messages['m'];
    expect(m).toMatchObject({ status: 'waiting_vaa', attempts: 0, vaaPolls: 2 });
  });

  it('marks a RELEASE whose token transfer failed on the spoke as deferred (claimable by the recipient)', async () => {
    const recipient = getAddress('0x000000000000000000000000000000000000c1a1');
    const token = '0x4200000000000000000000000000000000000006';
    const log = {
      address: GATEWAY,
      topics: encodeEventTopics({ abi: spokeGatewayAbi, eventName: 'ReleaseDeferred', args: { vaaHash: `0x${'aa'.repeat(32)}`, recipient, token } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [5n * 10n ** 14n]),
    };
    expect(releaseDeferred({ logs: [log] as never }, GATEWAY)).toEqual({ recipient, token, amount: 5n * 10n ** 14n });
    expect(releaseDeferred({ logs: [log] as never }, OLD_GATEWAY)).toBeNull();

    const { sender } = fakeSender({ logs: [log] });
    const relayer = new Relayer(relayCtx({ spokeSender: sender }) as never, fetch, () => 0);
    const vaa = await signDevVaa(GUARDIAN, {
      timestamp: 1,
      nonce: 0,
      emitterChain: 50,
      emitter: ADAPTER,
      sequence: 4n,
      consistencyLevel: 1,
      payload: '0xbeef',
    });
    relayer.store.update((s) => {
      s.messages['r'] = {
        ...deposit({ id: 'r', status: 'ready', vaa }),
        direction: 'release',
        source: 'devnet-hub',
        target: 'base-sepolia',
        emitterChain: 50,
        emitter: ADAPTER,
        sequence: 4n,
      };
    });
    await relayer.tick();
    expect(relayer.store.get().messages['r']).toMatchObject({ status: 'delivered', deferred: { recipient, token, amount: 5n * 10n ** 14n } });
  });

  it('keeps the newest 500 delivered messages and none older than a week, dropping their VAAs', async () => {
    const now = 30 * 24 * 3_600_000;
    const relayer = new Relayer(relayCtx() as never, fetch, () => now);
    relayer.store.update((s) => {
      for (let i = 0; i < 600; i++) s.messages[`d${i}`] = deposit({ id: `d${i}`, status: 'delivered', deliveredAt: now - i * 1_000, sequence: BigInt(i) });
      s.messages['old'] = deposit({ id: 'old', status: 'delivered', deliveredAt: now - 8 * 24 * 3_600_000 });
      s.messages['pending'] = deposit({ id: 'pending', status: 'waiting_vaa', observedAt: 0 });
    });
    (relayer as unknown as { advance: () => Promise<void> }).advance = async () => {};
    await relayer.tick();
    const ids = Object.keys(relayer.store.get().messages);
    expect(ids).toHaveLength(501);
    expect(ids).toContain('pending'); // undelivered messages are never pruned
    expect(ids).not.toContain('old');
    expect(ids).not.toContain('d599');
  });

  it('flags messages pending past 3× their source finality', () => {
    const now = 4 * 20 * 60_000;
    const relayer = new Relayer(relayCtx() as never, fetch, () => now);
    relayer.store.update((s) => {
      s.messages['late'] = deposit({ id: 'late', observedAt: 0, attempts: 3, lastError: 'execution reverted' });
      s.messages['fresh'] = deposit({ id: 'fresh', observedAt: now - 60_000, sequence: 2n });
    });
    const sum = relayer.summary(now);
    expect(sum).toMatchObject({ pending: 2, waitingVaa: 2, ready: 0, oldestPendingAgeSec: 4_800 });
    expect(sum.stuck.map((m) => m.id)).toEqual(['late']);
  });
});

describe('relayer finality and sequences (relayer-finality-gaps)', () => {
  it('scans guardian-signed sources only up to the finalized block', async () => {
    const ranges: [bigint, bigint][] = [];
    const spokeClient = {
      getBlockNumber: async () => 1_000n,
      getBlock: async ({ blockTag }: { blockTag: string }) => ({ number: blockTag === 'finalized' ? 900n : 1_000n }),
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => (ranges.push([fromBlock, toBlock]), []),
    };
    const relayer = new Relayer(relayCtx({ spokeClient, vaaApis: { 'base-sepolia': [VAA_API] } }) as never, fetch, () => 0);
    await relayer.tick();
    expect(ranges.at(-1)![1]).toBe(900n);
    expect(relayer.store.get().cursors['base-sepolia']?.block).toBe(901n);
  });

  it('without a finalized tag it scans to the latest block and waits out the finality window before the first VAA lookup', async () => {
    const logs: string[] = [];
    const spokeClient = {
      getBlockNumber: async () => 50n,
      getBlock: async () => Promise.reject(new Error('invalid block tag "finalized"')),
      getContractEvents: async () => [{ args: { sequence: 0n }, transactionHash: '0x' + '11'.repeat(32), blockNumber: 10n }],
    };
    const asked: bigint[] = [];
    const now = 1_000_000;
    const relayer = new Relayer(relayCtx({ spokeClient, vaaApis: { 'base-sepolia': [VAA_API] }, logs }) as never, vaaSource(new Map(), asked), () => now);
    await relayer.tick();
    const [m] = relayer.messages();
    expect(m.nextAttemptAt).toBe(now + 20 * 60_000); // Base Sepolia finality
    expect(asked).toEqual([]);
    expect(logs).toContain('RPC has no finalized block tag; scanning to the latest block');
  });

  it('recovers a message that never showed up in the logs from its sequence number', async () => {
    const vaa1 = await depositVaa(1n);
    const asked: bigint[] = [];
    const spokeClient = {
      getBlockNumber: async () => 100n,
      getBlock: async () => ({ number: 100n }),
      // A replica that served sequences 0 and 2 but missed 1 (or a reorg that moved it below the cursor).
      getContractEvents: async () => [0n, 2n].map((sequence) => ({ args: { sequence }, transactionHash: '0x' + '11'.repeat(32), blockNumber: 5n })),
    };
    const relayer = new Relayer(relayCtx({ spokeClient, vaaApis: { 'base-sepolia': [VAA_API] } }) as never, vaaSource(new Map([[1n, vaa1]]), asked), () => 0);
    (relayer as unknown as { advance: () => Promise<void> }).advance = async () => {};
    await relayer.tick();
    const recovered = relayer.messages().find((m) => m.sequence === 1n)!;
    expect(recovered).toMatchObject({ backfilled: true, status: 'ready', vaa: vaa1, target: 'devnet-hub', txHash: '0x' });
    expect(relayer.gaps()).toEqual([]);
    expect(relayer.store.get().sequences[`10004/${GATEWAY}`]).toEqual({ next: 3n, ahead: [] });
  });

  it('reports a gap it cannot fill yet', async () => {
    const spokeClient = {
      getBlockNumber: async () => 100n,
      getBlock: async () => ({ number: 100n }),
      getContractEvents: async () => [0n, 3n].map((sequence) => ({ args: { sequence }, transactionHash: '0x' + '11'.repeat(32), blockNumber: 5n })),
    };
    const relayer = new Relayer(relayCtx({ spokeClient, vaaApis: { 'base-sepolia': [VAA_API] } }) as never, vaaSource(new Map()), () => 0);
    (relayer as unknown as { advance: () => Promise<void> }).advance = async () => {};
    await relayer.tick();
    expect(relayer.gaps()).toEqual([{ emitter: `10004/${GATEWAY}`, missing: [1n, 2n] }]);
  });
});

describe('relayer after a redeploy (redeploy-agent-cursor-skip, state-survives-redeploy)', () => {
  /** State as an older agent left it: a bare cursor per network and messages of the replaced gateway. */
  const writeOldState = (dir: string) =>
    writeFileSync(
      join(dir, 'relayer-devnet.json'),
      JSON.stringify({
        cursors: { 'base-sepolia': { block: { $bigint: '999' }, contract: OLD_GATEWAY }, 'devnet-hub': { $bigint: '555' } },
        messages: {
          stale: {
            ...deposit({ id: 'stale', emitter: OLD_GATEWAY, status: 'ready', vaa: '0xdead' }),
            sequence: { $bigint: '1' },
            blockNumber: { $bigint: '1' },
          },
          done: { ...deposit({ id: 'done', emitter: OLD_GATEWAY, status: 'delivered' }), sequence: { $bigint: '2' }, blockNumber: { $bigint: '1' } },
          current: { ...deposit({ id: 'current', emitter: GATEWAY }), sequence: { $bigint: '3' }, blockNumber: { $bigint: '1' } },
        },
        sequences: { [`10004/${OLD_GATEWAY}`]: { next: { $bigint: '3' }, ahead: [] } },
      }),
    );

  it('rescans from the new start block and archives undelivered messages of the old contracts', async () => {
    const dir = stateDir();
    writeOldState(dir);
    const logs: string[] = [];
    const ranges: bigint[] = [];
    const spokeClient = {
      getBlockNumber: async () => 300n,
      getContractEvents: async ({ fromBlock }: { fromBlock: bigint }) => (ranges.push(fromBlock), []),
    };
    const relayer = new Relayer(relayCtx({ dir, spokeClient, logs }) as never, fetch, () => 0);
    expect(relayer.store.get().cursors).toEqual({});
    expect(Object.keys(relayer.store.get().messages)).toEqual(['current']);
    expect(relayer.store.get().messages['current'].targetContract).toBe(ADAPTER);
    expect(relayer.store.get().sequences).toEqual({});
    const archive = JSON.parse(readFileSync(join(dir, 'relayer-devnet.archived.json'), 'utf8'));
    expect(archive).toHaveLength(1);
    expect(archive[0].messages.map((m: { id: string }) => m.id)).toEqual(['stale']); // delivered ones need nothing
    expect(logs).toContain('cursor belongs to another deployment: rescanning from the start block');

    (relayer as unknown as { advance: () => Promise<void> }).advance = async () => {};
    await relayer.tick();
    expect(ranges[0]).toBe(0n); // the deployment's startBlock, not the old cursor 999
  });

  it('resumes its own cursor', async () => {
    const dir = stateDir();
    new JsonStore(join(dir, 'relayer-devnet.json'), {}).update((s: Record<string, unknown>) => {
      s.cursors = { 'base-sepolia': { block: 250n, contract: GATEWAY } };
      s.messages = {};
    });
    const relayer = new Relayer(relayCtx({ dir }) as never, fetch, () => 0);
    expect(relayer.store.get().cursors['base-sepolia']).toEqual({ block: 250n, contract: GATEWAY });
    expect(existsSync(join(dir, 'relayer-devnet.archived.json'))).toBe(false);
  });
});

describe('gas floor on Mezo (testnet: estimates far below what a VAA delivery uses)', () => {
  it('relayer deliveries never go below the VAA relay floor', async () => {
    // 24,000 is what a misbehaving backend estimated; the node mines what it accepts.
    const chain = scriptedChain({ estimateGas: 24_000n, onSend: (h, _tx, c) => c.mine(h) });
    const sender = new TxSender('devnet-hub', chain.client, chain.wallet, { receiptTimeoutMs: 1_000, pollMs: 2, log: () => {} });
    const hubClient = { getBlockNumber: async () => 0n, getContractEvents: async () => [], readContract: async () => false };
    const relayer = new Relayer(relayCtx({ hubClient, hubSender: sender }) as never, fetch, () => 0);
    const vaa = await depositVaa(2n);
    relayer.store.update((s) => {
      s.messages['g'] = deposit({ id: 'g', sequence: 2n, status: 'ready', vaa });
    });
    await relayer.tick();
    const [hash] = chain.accepted;
    expect(chain.gasOf(hash)).toBe(250_000n); // GAS_FLOOR.vaaRelay, not 24,000 × 1.3 + 20,000
    expect(relayer.store.get().messages['g']).toMatchObject({ status: 'delivered', deliveredTx: hash });
    expect(relayer.store.get().messages['g'].vaa).toBeUndefined();
  });
});

describe('relayer and transactions at the same nonce (final review A1)', () => {
  it('never marks a release delivered on the receipt of another transaction at its nonce, and retries it', async () => {
    const vaaX = await releaseVaa(1n);
    const vaaY = await releaseVaa(2n);
    let autoMine = false;
    let lookups = 0;
    const chain = scriptedChain({
      onSend: (h, _tx, c) => void (autoMine && c.mine(h)),
      // Release Y took over the nonce X left stuck; while Y waits, a builder that still had X's last attempt mines it.
      onCall: (method, params, c) => {
        const y = c.accepted[3];
        if (method === 'eth_getTransactionReceipt' && y !== undefined && params[0] === y && ++lookups === 2) c.mine(c.accepted[2]);
      },
    });
    // SpokeGateway.isConsumed: whether a mined transaction delivered that VAA.
    const vaaOf = new Map([vaaX, vaaY].map((v) => [vaaHash(v), v]));
    const consumed = (digest: Hex) => chain.mined.some((h) => (chain.dataOf(h) ?? '').includes(vaaOf.get(digest)!.slice(2)));
    const spokeClient = {
      getBlockNumber: async () => 0n,
      getContractEvents: async () => [],
      readContract: async ({ args }: { args: [Hex] }) => consumed(args[0]),
    };
    const sender = new TxSender('base-sepolia', chain.client, chain.wallet, { receiptTimeoutMs: 30, pollMs: 2, log: () => {} });
    let now = 1_000;
    const relayer = new Relayer(relayCtx({ spokeClient, spokeSender: sender }) as never, fetch, () => now);
    relayer.store.update((s) => {
      // Newest first: X is delivered before Y.
      s.messages['x'] = release({ id: 'x', sequence: 1n, status: 'ready', vaa: vaaX, observedAt: 2 });
      s.messages['y'] = release({ id: 'y', sequence: 2n, status: 'ready', vaa: vaaY, observedAt: 1 });
    });
    await relayer.tick();
    expect(chain.mined).toEqual([chain.accepted[2]]); // only X's last attempt, at nonce 0
    const y = relayer.store.get().messages['y'];
    expect(y).toMatchObject({ status: 'ready', attempts: 1 });
    expect(y.deliveredTx).toBeUndefined();
    expect(y.lastError).toMatch(/consumed by another transaction/);
    expect(relayer.store.get().messages['x']).toMatchObject({ status: 'ready', attempts: 1 }); // stuck: it may still be mined

    autoMine = true;
    now += 60_000; // past both backoffs
    await relayer.tick();
    // X was delivered by its own transaction after all; Y is sent again, at the next nonce.
    expect(relayer.store.get().messages['x']).toMatchObject({ status: 'delivered' });
    const delivered = relayer.store.get().messages['y'];
    expect(delivered.status).toBe('delivered');
    expect(chain.nonceOf(delivered.deliveredTx!)).toBe(1);
    expect(chain.dataOf(delivered.deliveredTx!)).toContain(vaaY.slice(2));
  });
});

describe('relayer and messages for replaced contracts (final review A5)', () => {
  it('archives a deposit addressed to the replaced hub adapter instead of retrying it forever', async () => {
    const dir = stateDir();
    const logs: string[] = [];
    // A rescan of a reused spoke sees a deposit made under the previous hub again: its payload names the old adapter.
    const vaas = new Map([
      [1n, await depositVaa(1n, GATEWAY, OLD_ADAPTER)],
      [2n, await depositVaa(2n)],
    ]);
    const { sender, sent } = fakeSender();
    const relayer = new Relayer(relayCtx({ dir, hubSender: sender, logs, vaaApis: { 'base-sepolia': [VAA_API] } }) as never, vaaSource(vaas), () => 0);
    relayer.store.update((s) => {
      s.messages['old'] = deposit({ id: 'old', sequence: 1n });
      s.messages['new'] = deposit({ id: 'new', sequence: 2n });
    });
    await relayer.tick();
    expect(Object.keys(relayer.store.get().messages)).toEqual(['new']);
    expect(relayer.store.get().messages['new'].status).toBe('delivered');
    expect(sent).toHaveLength(1); // nothing was sent for the old deposit
    expect(relayer.pending()).toEqual([]); // nothing left to flag on /health
    const archive = JSON.parse(readFileSync(join(dir, 'relayer-devnet.archived.json'), 'utf8'));
    expect(archive).toMatchObject([
      { reason: expect.stringMatching(new RegExp(`^undeliverable: its payload is addressed to ${OLD_ADAPTER}`)), messages: [{ id: 'old' }] },
    ]);
    expect(logs).toContain('message addressed to another contract: archived, not retried');
  });

  it('archives a release addressed to another spoke gateway', async () => {
    const dir = stateDir();
    const { sender, sent } = fakeSender();
    const relayer = new Relayer(relayCtx({ dir, spokeSender: sender }) as never, fetch, () => 0);
    const vaa = await releaseVaa(3n, OLD_GATEWAY);
    relayer.store.update((s) => {
      s.messages['r'] = release({ id: 'r', sequence: 3n, status: 'ready', vaa });
    });
    await relayer.tick();
    expect(relayer.store.get().messages['r']).toBeUndefined();
    expect(sent).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'relayer-devnet.archived.json'), 'utf8'))[0].messages[0]).toMatchObject({ id: 'r', vaa });
  });
});

describe('relayer and the finalized block tag (final review A7)', () => {
  const body = { method: 'eth_getBlockByNumber', params: ['finalized', false] };
  const url = 'https://rpc.example/v2/KEY';

  it.each([
    ['a timeout', () => new TimeoutError({ body, url })],
    ['a 503', () => new HttpRequestError({ body, url, status: 503, details: 'Service Unavailable' })],
  ])('%s on the finalized block fails that scan only, and never switches the source to the latest block', async (_what, failure) => {
    let fail = true;
    const ranges: [bigint, bigint][] = [];
    const logs: string[] = [];
    const spokeClient = {
      getBlockNumber: async () => 1_000n,
      getBlock: async () => {
        if (fail) throw failure(); // its message repeats the request body, which names "finalized"
        return { number: 900n };
      },
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => (ranges.push([fromBlock, toBlock]), []),
    };
    const relayer = new Relayer(relayCtx({ spokeClient, vaaApis: { 'base-sepolia': [VAA_API] }, logs }) as never, fetch, () => 0);
    await relayer.tick();
    expect(ranges).toEqual([]); // nothing scanned past the finalized block
    expect(relayer.failingScans().map((f) => f.network)).toEqual(['base-sepolia']);
    expect(logs).not.toContain('RPC has no finalized block tag; scanning to the latest block');
    fail = false;
    await relayer.tick();
    expect(ranges.at(-1)![1]).toBe(900n);
    expect(relayer.store.get().cursors['base-sepolia']?.block).toBe(901n);
  });

  it('scans an RPC that refuses the tag to the latest block for a while, then asks for the tag again', async () => {
    let refuses = true;
    let latest = 1_000n;
    let now = 0;
    let asked = 0;
    const logs: string[] = [];
    const spokeClient = {
      getBlockNumber: async () => latest,
      getBlock: async () => {
        asked += 1;
        if (refuses) throw new InvalidParamsRpcError(new RpcRequestError({ body, url, error: { code: -32_602, message: 'invalid block tag "finalized"' } }));
        return { number: latest - 20n };
      },
      getContractEvents: async () => [],
    };
    const relayer = new Relayer(relayCtx({ spokeClient, vaaApis: { 'base-sepolia': [VAA_API] }, logs }) as never, fetch, () => now);
    const cursor = () => relayer.store.get().cursors['base-sepolia']?.block;
    await relayer.tick();
    expect(cursor()).toBe(1_001n);
    expect(logs).toContain('RPC has no finalized block tag; scanning to the latest block');
    refuses = false;
    latest = 1_050n;
    now = FINALIZED_RETRY_MS - 1;
    await relayer.tick();
    expect([asked, cursor()]).toEqual([1, 1_051n]); // not asked again yet
    latest = 1_100n;
    now = FINALIZED_RETRY_MS + 1;
    await relayer.tick();
    expect([asked, cursor()]).toEqual([2, 1_081n]); // back to the finalized block
    expect(logs).toContain('RPC serves the finalized block tag again; scanning to the finalized block');
  });
});

describe('relayer deliveries per target chain (final review A11)', () => {
  it('a release stuck on one spoke holds up neither deposits to the hub nor the next ticks', async () => {
    let unblock!: () => void;
    const stalled = new Promise<void>((resolve) => (unblock = resolve));
    const spokeSent: Record<string, unknown>[] = [];
    const spokeSender = {
      address: KEEPER,
      send: async (request: Record<string, unknown>) => {
        spokeSent.push(request);
        await stalled; // e.g. unmined through every fee bump during a Sepolia fee spike
        return { hash: `0x${'44'.repeat(32)}`, receipt: { status: 'success', logs: [] }, gas: 0n, nonce: 0 };
      },
    };
    const { sender: hubSender, sent: hubSent } = fakeSender();
    const relayer = new Relayer(relayCtx({ hubSender, spokeSender, pollMs: 20 }) as never, fetch, () => 0);
    const releaseFirst = await releaseVaa(1n);
    const depositAfter = await depositVaa(1n);
    relayer.store.update((s) => {
      s.messages['r'] = release({ id: 'r', status: 'ready', vaa: releaseFirst, observedAt: 2 });
      s.messages['d'] = deposit({ id: 'd', status: 'ready', vaa: depositAfter, observedAt: 1 });
    });
    await relayer.tick();
    expect(hubSent).toHaveLength(1);
    expect(relayer.store.get().messages['d'].status).toBe('delivered');
    expect(relayer.store.get().messages['r'].status).toBe('ready'); // still in flight
    await relayer.tick(); // returns too, and does not deliver the in-flight release a second time
    expect(spokeSent).toHaveLength(1);
    expect(await relayer.idle(10)).toBe(false);
    unblock();
    expect(await relayer.idle(1_000)).toBe(true);
    expect(relayer.store.get().messages['r'].status).toBe('delivered');
  });
});
