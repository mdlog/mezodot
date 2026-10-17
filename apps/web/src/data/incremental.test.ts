import { describe, expect, it } from 'vitest';
import { resetIncrementalCache, scanIncremental } from './incremental';

describe('incremental chunked log scans (final review I5)', () => {
  it('scans history once in chunks under the RPC cap, then only new blocks', async () => {
    resetIncrementalCache();
    const ranges: [bigint, bigint][] = [];
    const fetchRange = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock >= 10_000n) throw new Error('maximum [from, to] blocks distance: 10000');
      ranges.push([fromBlock, toBlock]);
      return [fromBlock];
    };
    const first = await scanIncremental('k', 0n, 23_000n, fetchRange);
    expect(ranges.length).toBeGreaterThan(2);
    expect(first[0]).toBe(0n);
    ranges.length = 0;
    await scanIncremental('k', 0n, 23_010n, fetchRange);
    expect(ranges).toEqual([[23_001n, 23_010n]]);
  });

  it('keeps progress when a chunk fails and resumes on the next call', async () => {
    resetIncrementalCache();
    let fail = true;
    const seen: bigint[] = [];
    const fetchRange = async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (fromBlock >= 5_000n && fail) throw new Error('rpc');
      seen.push(fromBlock);
      return [fromBlock];
    };
    await expect(scanIncremental('k2', 0n, 12_000n, fetchRange)).rejects.toThrow('rpc');
    fail = false;
    const items = await scanIncremental('k2', 0n, 12_000n, fetchRange);
    expect(seen).toEqual([0n, 5_000n, 10_000n]); // chunk 0 not re-scanned
    expect(items).toEqual([0n, 5_000n, 10_000n]);
  });
});
