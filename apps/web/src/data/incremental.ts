import { blockRanges, type BlockRange } from '@mezodot/sdk';

type Cache = { next: bigint; items: unknown[] };
const caches = new Map<string, Cache>();

/**
 * Event history under public-RPC block-range caps: the first call scans [start, latest] in chunks,
 * later calls only scan blocks after the last completed chunk. Progress survives a failing chunk,
 * whose error is re-thrown so the UI can show it instead of an empty history.
 */
export async function scanIncremental<T>(key: string, start: bigint, latest: bigint, fetchRange: (range: BlockRange) => Promise<T[]>): Promise<T[]> {
  const cache = caches.get(key) ?? { next: start, items: [] };
  caches.set(key, cache);
  for (const range of blockRanges(cache.next > start ? cache.next : start, latest)) {
    const items = await fetchRange(range);
    cache.items.push(...items);
    cache.next = range.toBlock + 1n;
  }
  return cache.items as T[];
}

export const resetIncrementalCache = (): void => caches.clear();
