import { describe, expect, it } from 'vitest';
import { resetIncrementalCache, scanIncremental, spokeHistoryStart } from './incremental';

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

  it('uses the chunk size of the network (Base Sepolia public RPC: 200 blocks)', async () => {
    resetIncrementalCache();
    const sizes: bigint[] = [];
    const fetchRange = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 200n) throw new Error('eth_getLogs is limited to a 200 range');
      sizes.push(toBlock - fromBlock + 1n);
      return [];
    };
    await scanIncremental('k3', 1_000n, 1_999n, fetchRange, 200n);
    expect(sizes).toEqual([200n, 200n, 200n, 200n, 200n]);
  });

  it('bounds spoke lookback by request count: 50 chunks of the network cap, at most 100,000 blocks', () => {
    expect(spokeHistoryStart(5_000_000n, 0n, 200n)).toBe(4_990_000n); // Base: ~5.5 h of 2 s blocks
    expect(spokeHistoryStart(5_000_000n, 0n, 5_000n)).toBe(4_900_000n);
    expect(spokeHistoryStart(5_000_000n, 4_999_000n, 200n)).toBe(4_999_000n); // never before deployment
    expect(spokeHistoryStart(3_000n, 0n, 200n)).toBe(0n);
  });
});
