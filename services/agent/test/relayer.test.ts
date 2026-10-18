import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keccak256, sliceHex, type Hex } from 'viem';
import { signDevVaa, vaaBody } from '@mezodot/sdk';
import { messageId, vaaHash } from '../src/relayer';
import { JsonStore } from '../src/store';

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
    const vaa = await signDevVaa('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', m);
    expect(vaaHash(vaa)).toBe(keccak256(keccak256(vaaBody(m))));
    // Same body after the 72-byte header+signature.
    expect(sliceHex(vaa, 72)).toBe(vaaBody(m));
  });

  it('message ids are case-insensitive on the emitter', () => {
    expect(messageId(50, '0xABCDEF0000000000000000000000000000000001', 7n)).toBe(messageId(50, '0xabcdef0000000000000000000000000000000001', 7n));
  });

  it('store persists bigints across reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mezodot-'));
    const path = join(dir, 's.json');
    const a = new JsonStore<{ cursor: bigint | null }>(path, { cursor: null });
    a.update((s) => {
      s.cursor = 123n;
    });
    const b = new JsonStore<{ cursor: bigint | null }>(path, { cursor: null });
    expect(b.get().cursor).toBe(123n);
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
    const { Relayer } = await import('../src/relayer');
    const dir = mkdtempSync(join(tmpdir(), 'mezodot-relayer-'));
    const logs: string[] = [];
    const failingClient = { getBlockNumber: async () => Promise.reject(new Error('rpc down')) };
    const ctx = {
      config: { stateDir: dir, env: 'devnet', devGuardianKey: null },
      hub: { network: 'devnet-hub', client: failingClient, wallet: null, deployment: { startBlock: 0, wormholeChainId: 50, contracts: {} } },
      spokes: [{ network: 'devnet-spoke', client: failingClient, wallet: null, deployment: { startBlock: 0, wormholeChainId: 10004, contracts: {} } }],
      log: (_s: string, message: string) => logs.push(message),
    };
    let now = 1_000_000;
    const relayer = new Relayer(ctx as never, fetch, () => now);
    const attempted: string[] = [];
    (relayer as unknown as { advance: (m: { id: string }) => Promise<void> }).advance = async (m) => {
      attempted.push(m.id);
      throw new Error('transient');
    };
    relayer.store.update((s) => {
      s.messages['a'] = {
        id: 'a',
        direction: 'deposit',
        source: 'devnet-spoke',
        target: 'devnet-hub',
        emitterChain: 10004,
        emitter: '0x0000000000000000000000000000000000000001',
        sequence: 1n,
        txHash: '0x01',
        blockNumber: 1n,
        status: 'waiting_vaa',
        attempts: 0,
        observedAt: 0,
      };
    });

    for (let i = 0; i < 20; i++) {
      await relayer.tick(); // scan failures must not throw
      now += 60 * 60_000; // jump past any backoff
    }
    const m = relayer.store.get().messages['a'];
    expect(m.status).not.toBe('failed');
    expect(m.attempts).toBe(20);
    expect(relayer.pending().map((x) => x.id)).toEqual(['a']);
    expect(logs.filter((l) => l === 'scan failed').length).toBeGreaterThanOrEqual(40);

    // Within the backoff window nothing is attempted.
    const before = attempted.length;
    await relayer.tick();
    now += 1;
    await relayer.tick();
    expect(attempted.length).toBe(before + 1);
  });
});

describe('relayer scanning and delivery (audit: agent)', () => {
  const ctxWith = (spokeClient: unknown, hubClient: unknown, dir: string, wallet: unknown = null) => ({
    config: { stateDir: dir, env: 'devnet', devGuardianKey: null },
    hub: {
      network: 'devnet-hub',
      client: hubClient,
      wallet,
      deployment: {
        startBlock: 0,
        wormholeChainId: 50,
        contracts: { wormholeAdapter: '0x00000000000000000000000000000000000000ad', keeperGateway: '0x00000000000000000000000000000000000000ee' },
      },
    },
    spokes: [
      {
        network: 'base-sepolia',
        client: spokeClient,
        wallet: null,
        deployment: { startBlock: 0, wormholeChainId: 10004, contracts: { spokeGateway: '0x00000000000000000000000000000000000000ab' } },
      },
    ],
    log: () => {},
  });

  it('scans within the RPC block-range cap, shrinking on refusal and draining a backlog per tick', async () => {
    const { Relayer } = await import('../src/relayer');
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
    const hubClient = { getBlockNumber: async () => 0n, getContractEvents: async () => [] };
    const relayer = new Relayer(ctxWith(spokeClient, hubClient, mkdtempSync(join(tmpdir(), 'mezodot-relayer-'))) as never, fetch, () => 0);
    (relayer as unknown as { advance: () => Promise<void> }).advance = async () => {};
    await relayer.tick();
    expect(calls.every(([f, t]) => t - f + 1n <= 100n)).toBe(true);
    expect(relayer.store.get().cursors['base-sepolia']).toBe(2_401n); // caught up in one tick
    expect(relayer.messages().map((m) => m.sequence)).toEqual([7n]);
  });

  it('does not shrink the window for errors unrelated to the block range', async () => {
    const { Relayer } = await import('../src/relayer');
    const sizes: bigint[] = [];
    const spokeClient = {
      getBlockNumber: async () => 10_000n,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        sizes.push(toBlock - fromBlock + 1n);
        throw new Error('fetch failed: ECONNRESET');
      },
    };
    const hubClient = { getBlockNumber: async () => 0n, getContractEvents: async () => [] };
    const relayer = new Relayer(ctxWith(spokeClient, hubClient, mkdtempSync(join(tmpdir(), 'mezodot-relayer-'))) as never, fetch, () => 0);
    await relayer.tick();
    await relayer.tick();
    expect(sizes).toEqual([200n, 200n]); // one attempt per tick at the network's cap, no shrinking
  });

  it('a delivery whose transaction reverts is retried, not recorded as delivered', async () => {
    const { Relayer } = await import('../src/relayer');
    const hubClient = {
      getBlockNumber: async () => 0n,
      getContractEvents: async () => [],
      readContract: async () => false, // not consumed yet
      estimateContractGas: async () => 100_000n,
      waitForTransactionReceipt: async () => ({ status: 'reverted' }),
    };
    const spokeClient = { getBlockNumber: async () => 0n, getContractEvents: async () => [] };
    const wallet = { writeContract: async () => '0x' + '22'.repeat(32) };
    const vaa = await signDevVaa('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', {
      timestamp: 1,
      nonce: 0,
      emitterChain: 10004,
      emitter: '0x00000000000000000000000000000000000000ab',
      sequence: 1n,
      consistencyLevel: 1,
      payload: '0xbeef',
    });
    const relayer = new Relayer(ctxWith(spokeClient, hubClient, mkdtempSync(join(tmpdir(), 'mezodot-relayer-')), wallet) as never, fetch, () => 0);
    relayer.store.update((s) => {
      s.messages['m'] = {
        id: 'm',
        direction: 'deposit',
        source: 'base-sepolia',
        target: 'devnet-hub',
        emitterChain: 10004,
        emitter: '0x00000000000000000000000000000000000000ab',
        sequence: 1n,
        txHash: '0x01',
        blockNumber: 1n,
        status: 'ready',
        attempts: 0,
        observedAt: 0,
        vaa,
      };
    });
    await relayer.tick();
    const m = relayer.store.get().messages['m'];
    expect(m.status).toBe('ready');
    expect(m.attempts).toBe(1);
    expect(m.lastError).toMatch(/reverted/);
  });
});

describe('gas buffer on Mezo (testnet: a redeem estimated exactly ran out of gas)', () => {
  it('relayer deliveries carry the node estimate plus the buffer', async () => {
    const { Relayer } = await import('../src/relayer');
    const sentGas: (bigint | undefined)[] = [];
    const hubClient = {
      getBlockNumber: async () => 0n,
      getContractEvents: async () => [],
      readContract: async () => false,
      estimateContractGas: async () => 100_000n,
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    };
    const wallet = {
      account: { address: '0x00000000000000000000000000000000000000ee' },
      writeContract: async (req: { gas?: bigint }) => (sentGas.push(req.gas), '0x' + '33'.repeat(32)),
    };
    const spokeClient = { getBlockNumber: async () => 0n, getContractEvents: async () => [] };
    const ctx = {
      config: { stateDir: mkdtempSync(join(tmpdir(), 'mezodot-relayer-')), env: 'devnet', devGuardianKey: null },
      hub: {
        network: 'devnet-hub',
        client: hubClient,
        wallet,
        deployment: {
          startBlock: 0,
          wormholeChainId: 50,
          contracts: { wormholeAdapter: '0x00000000000000000000000000000000000000ad', keeperGateway: '0x00000000000000000000000000000000000000ee' },
        },
      },
      spokes: [
        {
          network: 'base-sepolia',
          client: spokeClient,
          wallet: null,
          deployment: { startBlock: 0, wormholeChainId: 10004, contracts: { spokeGateway: '0x00000000000000000000000000000000000000ab' } },
        },
      ],
      log: () => {},
    };
    const vaa = await signDevVaa('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', {
      timestamp: 1,
      nonce: 0,
      emitterChain: 10004,
      emitter: '0x00000000000000000000000000000000000000ab',
      sequence: 2n,
      consistencyLevel: 1,
      payload: '0xbeef',
    });
    const relayer = new Relayer(ctx as never, fetch, () => 0);
    relayer.store.update((s) => {
      s.messages['g'] = {
        id: 'g',
        direction: 'deposit',
        source: 'base-sepolia',
        target: 'devnet-hub',
        emitterChain: 10004,
        emitter: '0x00000000000000000000000000000000000000ab',
        sequence: 2n,
        txHash: '0x01',
        blockNumber: 1n,
        status: 'ready',
        attempts: 0,
        observedAt: 0,
        vaa,
      };
    });
    await relayer.tick();
    expect(sentGas).toEqual([150_000n]); // 100,000 × 1.3 + 20,000
    expect(relayer.store.get().messages['g'].status).toBe('delivered');
  });
});
