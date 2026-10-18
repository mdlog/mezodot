import { urlHost } from './errors';

/** Consecutive failures (network error, timeout, HTTP 429 or 5xx) after which a host is skipped for a while. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

/**
 * Fails fast while an upstream keeps failing, so a dead endpoint costs one quick error per call instead of a
 * full timeout on every loop tick.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold = BREAKER_THRESHOLD,
    private readonly cooldownMs = BREAKER_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until requests are allowed again (0 when closed). */
  openFor(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  succeeded(): void {
    this.failures = 0;
  }

  failed(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.failures = 0;
    }
  }
}

const hostOf = (input: Parameters<typeof fetch>[0]): string =>
  urlHost(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);

/**
 * `fetch` for external services (Wormholescan, Supra, Hermes, CoinGecko, alert webhooks): every request gets a
 * deadline (undici would otherwise wait up to 300 s for headers and body, stalling a whole loop), and each host
 * gets a circuit breaker. Errors name the host only, never the full URL.
 */
export function guardedFetch(timeoutMs: number, base: typeof fetch = fetch, now: () => number = Date.now): typeof fetch {
  const breakers = new Map<string, CircuitBreaker>();
  const breakerFor = (host: string) => {
    let b = breakers.get(host);
    if (!b) breakers.set(host, (b = new CircuitBreaker(BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS, now)));
    return b;
  };

  return async (input, init) => {
    const host = hostOf(input);
    const breaker = breakerFor(host);
    const wait = breaker.openFor();
    if (wait > 0) throw new Error(`${host} is failing; skipping requests for ${Math.ceil(wait / 1000)} s`);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    let res: Response;
    try {
      res = await base(input, { ...init, signal });
    } catch (err) {
      breaker.failed();
      if (deadline.aborted) throw new Error(`${host} did not answer within ${timeoutMs} ms`);
      throw new Error(`request to ${host} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    if (res.status === 429 || res.status >= 500) breaker.failed();
    else breaker.succeeded();
    return res;
  };
}

/**
 * Maps `items` through `fn` with at most `limit` calls in flight, like Promise.allSettled: one failure does not
 * stop the others. Bounds RPC fan-out (e.g. one position read per indexed borrower).
 */
export async function settleLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
