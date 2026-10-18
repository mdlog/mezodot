import { MAX_LOG_RANGE, blockRanges, type BlockRange } from '@mezodot/sdk';

type Cache = { next: bigint; items: unknown[] };
const caches = new Map<string, Cache>();

/**
 * Event history under public-RPC block-range caps: the first call scans [start, latest] in chunks,
 * later calls only scan blocks after the last completed chunk. Progress survives a failing chunk,
 * whose error is re-thrown so the UI can show it instead of an empty history.
 */
export async function scanIncremental<T>(
  key: string,
  start: bigint,
  latest: bigint,
  fetchRange: (range: BlockRange) => Promise<T[]>,
  chunk: bigint = MAX_LOG_RANGE,
): Promise<T[]> {
  const cache = caches.get(key) ?? { next: start, items: [] };
  caches.set(key, cache);
  for (const range of blockRanges(cache.next > start ? cache.next : start, latest, chunk)) {
    const items = await fetchRange(range);
    cache.items.push(...items);
    cache.next = range.toBlock + 1n;
  }
  return cache.items as T[];
}

export const resetIncrementalCache = (): void => caches.clear();

/** Most blocks of spoke history the UI reads, and the most requests it spends reading it. */
export const SPOKE_HISTORY_BLOCKS = 100_000n;
const SPOKE_HISTORY_CHUNKS = 50n;

/**
 * First block of the spoke history window: at most SPOKE_HISTORY_CHUNKS requests of the network's log cap
 * (Base Sepolia's 200-block cap gives ~5.5 h; deposits stay visible on the hub as credits), never before
 * the gateway was deployed.
 */
export function spokeHistoryStart(latest: bigint, deployBlock: bigint, maxLogRange: bigint): bigint {
  const span = maxLogRange * SPOKE_HISTORY_CHUNKS < SPOKE_HISTORY_BLOCKS ? maxLogRange * SPOKE_HISTORY_CHUNKS : SPOKE_HISTORY_BLOCKS;
  const floor = latest > span ? latest - span : 0n;
  return deployBlock > floor ? deployBlock : floor;
}
