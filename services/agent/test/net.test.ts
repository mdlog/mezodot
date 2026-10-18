import { describe, expect, it } from 'vitest';
import { publicError, redactUrls, urlHost } from '../src/errors';
import { CircuitBreaker, guardedFetch, settleLimited } from '../src/net';
import { LogWindow, MIN_LOG_WINDOW, isRangeRefused, isRateLimited } from '../src/scan';

describe('error text safe to return (rpc-url-leak)', () => {
  it("keeps viem's one-line summary and drops the URL and request body it appends", () => {
    // What viem 2.x builds for a failing keyed RPC: shortMessage, then "URL: …" and the request body.
    const err = Object.assign(
      new Error('HTTP request failed.\n\nStatus: 429\nURL: https://rpc.example/v2/SECRET_API_KEY_123\nRequest body: {"method":"eth_call"}'),
      {
        shortMessage: 'HTTP request failed.',
      },
    );
    expect(publicError(err)).toBe('HTTP request failed.');
    expect(publicError(new Error('HTTP request failed.\nURL: https://rpc.example/v2/SECRET'))).toBe('HTTP request failed.');
  });

  it('redacts a URL even on the first line, and bounds the length', () => {
    expect(publicError(new Error('fetch https://api.example/v1/x?key=SECRET failed'))).toBe('fetch [url] failed');
    expect(redactUrls('a wss://rpc.example/ws/KEY b http://x c')).toBe('a [url] b [url] c');
    expect(publicError(new Error('x'.repeat(1_000)))).toHaveLength(300);
    expect(publicError('plain string')).toBe('plain string');
    expect(publicError(new TypeError(''))).toBe('TypeError');
  });

  it('names hosts only', () => {
    expect(urlHost('https://rpc.example:8443/v2/KEY?x=1')).toBe('rpc.example:8443');
    expect(urlHost('nope')).toBe('[invalid url]');
  });
});

describe('external HTTP with deadlines and circuit breakers (no-fetch-timeouts)', () => {
  it('aborts a request that does not answer within the deadline, naming only the host', async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const f = guardedFetch(50, hanging);
    const started = Date.now();
    await expect(f('https://supra.example/get_proof?key=SECRET')).rejects.toThrow(/^supra\.example did not answer within 50 ms$/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('opens a per-host breaker after repeated failures and closes it after the cooldown', async () => {
    let now = 0;
    let calls = 0;
    const flaky = (async (input: string) => (calls++, new Response('busy', { status: input.includes('bad') ? 503 : 200 }))) as unknown as typeof fetch;
    const f = guardedFetch(1_000, flaky, () => now);
    for (let i = 0; i < 3; i++) expect((await f('https://bad.example/x')).status).toBe(503);
    await expect(f('https://bad.example/x')).rejects.toThrow(/bad\.example is failing; skipping requests for 30 s/);
    expect(calls).toBe(3); // skipped without a request
    expect((await f('https://good.example/x')).status).toBe(200); // other hosts are unaffected
    now += 30_001;
    expect((await f('https://bad.example/x')).status).toBe(503);
    expect(calls).toBe(5);
  });

  it('a success resets the failure count', () => {
    let now = 0;
    const b = new CircuitBreaker(3, 1_000, () => now);
    b.failed();
    b.failed();
    b.succeeded();
    b.failed();
    b.failed();
    expect(b.openFor()).toBe(0);
    b.failed();
    expect(b.openFor()).toBe(1_000);
    now += 400;
    expect(b.openFor()).toBe(600);
  });
});

describe('bounded fan-out (liquidator-rpc-fanout)', () => {
  it('keeps at most `limit` calls in flight, in order, isolating failures', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await settleLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 4) throw new Error('read failed');
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 30, 'x', 50, 60, 70]);
    expect(await settleLimited([], 8, async () => 1)).toEqual([]);
  });
});

describe('eth_getLogs windows (relayer-finality-gaps)', () => {
  it('tells a refused range from rate limiting', () => {
    expect(isRangeRefused(new Error('eth_getLogs is limited to a 200 range'))).toBe(true);
    expect(isRangeRefused(new Error('maximum [from, to] blocks distance: 10000'))).toBe(true);
    expect(isRangeRefused(new Error('query returned more than 10000 results'))).toBe(true);
    for (const m of ['HTTP request failed. Status: 429', 'Too Many Requests', 'exceeded its compute units quota', 'rate limit exceeded']) {
      expect(isRateLimited(new Error(m))).toBe(true);
      expect(isRangeRefused(new Error(m))).toBe(false);
    }
    expect(isRangeRefused(new Error('fetch failed: ECONNRESET'))).toBe(false);
  });

  it('halves on a refused range down to the minimum and grows back after a run of successes', () => {
    const w = new LogWindow(200n);
    expect(w.shrink(new Error('Too Many Requests'))).toBe(false);
    expect(w.size).toBe(200n);
    expect(w.shrink(new Error('range too large'))).toBe(true);
    expect(w.size).toBe(100n);
    for (let i = 0; i < 10; i++) w.shrink(new Error('range too large'));
    expect(w.size).toBe(MIN_LOG_WINDOW);
    expect(w.shrink(new Error('range too large'))).toBe(false); // nothing smaller to try
    for (let i = 0; i < 19; i++) w.succeeded();
    expect(w.size).toBe(MIN_LOG_WINDOW);
    w.succeeded();
    expect(w.size).toBe(2n * MIN_LOG_WINDOW);
    for (let i = 0; i < 20 * 10; i++) w.succeeded();
    expect(w.size).toBe(200n); // never above the network's cap
  });
});
