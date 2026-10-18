import { afterEach, describe, expect, it } from 'vitest';
import { SCAN_CONCURRENCY, resetIncrementalCache, scanIncremental, setScanStorage, spokeHistoryStart, type ScanStorage } from './incremental';

const memoryStorage = (): ScanStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

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

describe('scan progress across reloads and refetches (full-history-log-scans)', () => {
  afterEach(() => setScanStorage(null));

  it('continues from the stored block after a reload instead of the deployment block', async () => {
    const storage = memoryStorage();
    setScanStorage(storage);
    resetIncrementalCache();
    const scanned: bigint[] = [];
    const fetchRange = async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      scanned.push(fromBlock);
      return [{ block: fromBlock, amount: 10n ** 30n }];
    };
    await scanIncremental('persisted', 0n, 14_999n, fetchRange, 5_000n, { persist: true });
    expect(scanned).toEqual([0n, 5_000n, 10_000n]);

    resetIncrementalCache(); // a reload: memory is gone, browser storage is not
    scanned.length = 0;
    const items = await scanIncremental('persisted', 0n, 15_100n, fetchRange, 5_000n, { persist: true });
    expect(scanned).toEqual([15_000n]);
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ block: 0n, amount: 10n ** 30n }); // bigints survive the round trip
  });

  it('keeps progress in memory only unless asked to persist', async () => {
    const storage = memoryStorage();
    setScanStorage(storage);
    resetIncrementalCache();
    await scanIncremental('memory-only', 0n, 100n, async () => [1n]);
    expect(storage.data.size).toBe(0);
  });

  it('never appends the same chunks twice when a refetch starts mid-scan', async () => {
    resetIncrementalCache();
    let calls = 0;
    const fetchRange = async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls++;
      await new Promise((r) => setTimeout(r, 1));
      return [fromBlock];
    };
    const [a, b] = await Promise.all([scanIncremental('shared', 0n, 49_999n, fetchRange, 5_000n), scanIncremental('shared', 0n, 49_999n, fetchRange, 5_000n)]);
    expect(calls).toBe(10);
    expect(a).toHaveLength(10);
    expect(b).toEqual(a);
  });

  it('requests a few chunks at a time', async () => {
    resetIncrementalCache();
    let inFlight = 0;
    let peak = 0;
    const fetchRange = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return [];
    };
    await scanIncremental('parallel', 0n, 99_999n, fetchRange, 5_000n);
    expect(peak).toBe(SCAN_CONCURRENCY);
  });
});
