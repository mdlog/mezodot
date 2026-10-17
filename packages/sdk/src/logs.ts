/**
 * Block-range chunking for log queries. Public RPCs cap eth_getLogs ranges (Mezo testnet:
 * "maximum [from, to] blocks distance: 10000"), so every history scan goes through these helpers.
 */

/** Conservative default below Mezo's 10,000-block cap (other public RPCs often allow less). */
export const MAX_LOG_RANGE = 5_000n;

export type BlockRange = { fromBlock: bigint; toBlock: bigint };

/** Splits [from, to] (inclusive) into consecutive ranges of at most `size` blocks. */
export function blockRanges(from: bigint, to: bigint, size: bigint = MAX_LOG_RANGE): BlockRange[] {
  if (size <= 0n) throw new Error('size must be positive');
  const out: BlockRange[] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    out.push({ fromBlock: start, toBlock: end });
  }
  return out;
}

/**
 * Runs `query` over [from, to] in chunks, sequentially (keeps RPC load bounded), concatenating results.
 * Throws on the first failing chunk so callers can surface the error instead of showing partial history.
 */
export async function getLogsChunked<T>(from: bigint, to: bigint, query: (range: BlockRange) => Promise<T[]>, size: bigint = MAX_LOG_RANGE): Promise<T[]> {
  const out: T[] = [];
  for (const range of blockRanges(from, to, size)) out.push(...(await query(range)));
  return out;
}
