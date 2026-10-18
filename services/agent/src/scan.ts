/** Smallest eth_getLogs window a scanner shrinks to when an RPC refuses a range. */
export const MIN_LOG_WINDOW = 16n;
/** Successful windows in a row after which a shrunk window doubles again. */
const GROW_AFTER = 20;

/** Throttling (checked first): the request is fine, the provider wants fewer of them. */
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit|throttl|request limit|exceeded .*(quota|capacity|credits)/i;
/** "Range too large", worded differently by every provider. */
const RANGE_REFUSED = /range|limit|exceed|too (many|large|big)|blocks distance|block span|response size|more than \d+ results/i;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const isRateLimited = (err: unknown): boolean => RATE_LIMITED.test(messageOf(err));
export const isRangeRefused = (err: unknown): boolean => !isRateLimited(err) && RANGE_REFUSED.test(messageOf(err));

/**
 * The eth_getLogs block window a scanner uses on one network: starts at the network's known public-RPC cap,
 * halves when the RPC refuses a range, and grows back after a run of successes (a custom RPC's limit can be
 * temporary). Rate limiting never shrinks it: smaller windows would only mean more requests.
 */
export class LogWindow {
  private value: bigint;
  private streak = 0;

  constructor(
    readonly max: bigint,
    readonly min: bigint = MIN_LOG_WINDOW,
  ) {
    this.value = max;
  }

  get size(): bigint {
    return this.value;
  }

  /** Halves the window for a refused range; false when `err` is something else or the window is already minimal. */
  shrink(err: unknown): boolean {
    if (!isRangeRefused(err) || this.value <= this.min) return false;
    this.value = this.value / 2n > this.min ? this.value / 2n : this.min;
    this.streak = 0;
    return true;
  }

  succeeded(): void {
    if (this.value >= this.max) return;
    this.streak += 1;
    if (this.streak < GROW_AFTER) return;
    this.value = this.value * 2n < this.max ? this.value * 2n : this.max;
    this.streak = 0;
  }
}
