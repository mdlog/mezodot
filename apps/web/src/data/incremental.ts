import { MAX_LOG_RANGE, blockRanges, type BlockRange } from '@mezodot/sdk';

type Cache = { next: bigint; items: unknown[] };
const caches = new Map<string, Cache>();
/** The scan running per key: a refetch that starts mid-scan waits for it instead of appending the same chunks twice. */
const running = new Map<string, Promise<unknown>>();

/** Chunks requested at once: fast first loads without tripping public-RPC rate limits. */
export const SCAN_CONCURRENCY = 4;

// --- Persistence (per browser): reloads continue from the last scanned block instead of the deployment block ---

const STORE_PREFIX = 'mezodot-scan-v1:';

/** Minimal storage surface (localStorage in the app, a Map in tests). */
export type ScanStorage = Pick<Storage, 'getItem' | 'setItem'>;

let storage: ScanStorage | null = (() => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // storage blocked: scans stay in memory
  }
})();

export const setScanStorage = (next: ScanStorage | null): void => {
  storage = next;
};

const encode = (cache: Cache) => JSON.stringify(cache, (_, v: unknown) => (typeof v === 'bigint' ? { $n: v.toString() } : v));
const decode = (raw: string): Cache | null => {
  const value = JSON.parse(raw, (_, v: unknown) =>
    v !== null && typeof v === 'object' && Object.keys(v).length === 1 && typeof (v as { $n?: unknown }).$n === 'string' ? BigInt((v as { $n: string }).$n) : v,
  ) as Partial<Cache>;
  return typeof value.next === 'bigint' && Array.isArray(value.items) ? { next: value.next, items: value.items } : null;
};

function load(key: string): Cache | null {
  try {
    const raw = storage?.getItem(STORE_PREFIX + key);
    return raw ? decode(raw) : null;
  } catch {
    return null;
  }
}

function save(key: string, cache: Cache) {
  try {
    storage?.setItem(STORE_PREFIX + key, encode(cache));
  } catch {
    // quota exceeded or storage blocked: the in-memory cache still saves this session's requests
  }
}

export type ScanOptions = {
  /** Keep progress in browser storage. Items must be JSON data (bigints are encoded); include the deployment in the key. */
  persist?: boolean;
  concurrency?: number;
};

/**
 * Event history under public-RPC block-range caps: the first call scans [start, latest] in chunks (a few at a
 * time), later calls only scan blocks after the last completed chunk. Progress survives a failing chunk, whose
 * error is re-thrown so the UI can show it instead of an empty history.
 */
export function scanIncremental<T>(
  key: string,
  start: bigint,
  latest: bigint,
  fetchRange: (range: BlockRange) => Promise<T[]>,
  chunk: bigint = MAX_LOG_RANGE,
  options: ScanOptions = {},
): Promise<T[]> {
  const previous = running.get(key);
  const scan = (async () => {
    if (previous) await previous.catch(() => undefined);
    return scanFrom(key, start, latest, fetchRange, chunk, options);
  })();
  running.set(key, scan);
  void scan
    .catch(() => undefined)
    .finally(() => {
      if (running.get(key) === scan) running.delete(key);
    });
  return scan;
}

async function scanFrom<T>(
  key: string,
  start: bigint,
  latest: bigint,
  fetchRange: (range: BlockRange) => Promise<T[]>,
  chunk: bigint,
  { persist = false, concurrency = SCAN_CONCURRENCY }: ScanOptions,
): Promise<T[]> {
  let cache = caches.get(key);
  if (!cache) {
    cache = (persist ? load(key) : null) ?? { next: start, items: [] };
    caches.set(key, cache);
  }
  const ranges = blockRanges(cache.next > start ? cache.next : start, latest, chunk);
  try {
    for (let i = 0; i < ranges.length; i += concurrency) {
      const batch = ranges.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((range) => fetchRange(range)));
      // Progress stays contiguous: chunks after a failed one are fetched again next time.
      for (const [j, result] of results.entries()) {
        if (result.status === 'rejected') throw result.reason;
        cache.items.push(...result.value);
        cache.next = batch[j].toBlock + 1n;
      }
    }
  } finally {
    if (persist && ranges.length > 0) save(key, cache);
  }
  return cache.items as T[];
}

export const resetIncrementalCache = (): void => {
  caches.clear();
  running.clear();
};

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
