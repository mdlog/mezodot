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
