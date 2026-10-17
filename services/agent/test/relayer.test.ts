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
