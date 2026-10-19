import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PRICE_SYMBOLS, type OracleState, type PriceSymbol } from '@mezodot/sdk';
import { loadConfig } from '../src/config';
import { createContext } from '../src/context';
import { OracleWatchdog } from '../src/oracle/watchdog';
import type { Services } from '../src/services';

const LEAKY = new Error('HTTP request failed.\n\nURL: https://rpc.example/v2/SECRET_API_KEY_123\nRequest body: {"method":"eth_call"}');

type Overrides = { testnet?: boolean; health?: { ok: boolean }; watchdog?: unknown; risk?: unknown };

/** Devnet context (no live chain needed); `testnet: true` only flips the env flag. */
async function serve(opts: Overrides = {}, calls: unknown[] = []) {
  const { startHttp } = await import('../src/http');
  const ctx = createContext(loadConfig({ MEZODOT_ENV: 'devnet', STATE_DIR: '/tmp/mezodot-test-state', HTTP_PORT: '0' }), () => {});
  if (opts.testnet) ctx.config.env = 'testnet';
  const report = { checkedAt: 1, healthy: true, feeds: [] };
  const services = {
    ctx,
    relayer: { messages: () => [], pending: () => [], isStuck: () => false },
    liquidator: { lastEvaluations: [], lastRun: null, lastAssessments: new Map() },
    risk: opts.risk ?? { report: () => null, lastError: () => null },
    revenue: { report: () => null, refresh: async () => ({ totals: { reservesUsd: 0, treasuryCollateralUsd: 0 } }) },
    watch: { recent: () => Array.from({ length: 80 }, (_, i) => ({ event: 'CapsSet', blockNumber: String(80 - i) })), lastError: null },
    monitor: {
      report: () => ({ ok: opts.health?.ok ?? true, status: opts.health?.ok === false ? 'degraded' : 'ok', modules: ['http'], keeper: null }),
      metrics: () => '# HELP mezodot_agent_up Always 1 while the agent answers.\n# TYPE mezodot_agent_up gauge\nmezodot_agent_up{env="devnet"} 1\n',
    },
    oracle: {
      update: async (symbols: PriceSymbol[]) => {
        calls.push(['update', symbols]);
        if (symbols.includes('USDC')) throw new Error('Supra proof service error 502');
        return { updates: ['0x02ab'], prices: { ETH: { price: 2_412.98, publishTime: 1, source: 'supra' } }, missing: [] };
      },
      setMockPrices: (p: Record<string, number>) => (calls.push(['set', p]), { MUSD: 1, MEZO: 0.008, ETH: p.ETH ?? 3_200, USDC: 1 }),
    },
    watchdog: opts.watchdog ?? {
      status: () => ({ report, stale: false, ageSec: 3, error: null }),
      refresh: async () => report,
    },
  } as unknown as Services;
  const server = startHttp(services, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/** Sends a raw request line that fetch() would refuse to produce. */
const rawRequest = (port: number, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = '';
    socket.on('data', (c) => (data += c.toString()));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });

/** Streams `bytes` to /mcp without a Content-Length (chunked), resolving with the status the server answers. */
const streamUpload = (port: number, bytes: number): Promise<{ status: number; sent: number }> =>
  new Promise((resolve, reject) => {
    let sent = 0;
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, sent });
      },
    );
    req.on('error', (err) => (sent > 0 ? resolve({ status: -1, sent }) : reject(err)));
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pump = () => {
      while (sent < bytes) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });

describe('oracle endpoints', () => {
  it('serves pull updates for known symbols only', async () => {
    const calls: unknown[] = [];
    const { server, base } = await serve({}, calls);
    try {
      const ok = await fetch(`${base}/oracle/update?symbols=ETH,MEZO,ETH`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBe('*');
      expect((await ok.json()).updates).toEqual(['0x02ab']);
      expect(calls).toEqual([['update', ['MEZO', 'ETH']]]);
      expect((await fetch(`${base}/oracle/update?symbols=DOGE`)).status).toBe(400);
      expect((await fetch(`${base}/oracle/update`)).status).toBe(400);
      const down = await fetch(`${base}/oracle/update?symbols=USDC`);
      expect(down.status).toBe(502);
      expect((await down.json()).error).toBe('Supra proof service error 502');
    } finally {
      server.close();
    }
  });

  it('reports oracle health, with 503 once the report is stale or unhealthy', async () => {
    const fresh = await serve();
    try {
      const res = await fetch(`${fresh.base}/oracle/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ checkedAt: 1, healthy: true, feeds: [], stale: false, ageSec: 3, error: null });
    } finally {
      fresh.server.close();
    }
    const report = { checkedAt: 1, healthy: true, feeds: [] };
    // The router stays unreadable: the old report is served as stale.
    const stale = await serve({
      watchdog: { status: () => ({ report, stale: true, ageSec: 900, error: 'HTTP request failed.' }), refresh: async () => Promise.reject(LEAKY) },
    });
    try {
      const res = await fetch(`${stale.base}/oracle/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ stale: true, ageSec: 900, error: 'HTTP request failed.' });
    } finally {
      stale.server.close();
    }
    const never = await serve({
      watchdog: {
        status: () => ({ report: null, stale: true, ageSec: null, error: null }),
        refresh: async () => Promise.reject(LEAKY),
      },
    });
    try {
      const res = await fetch(`${never.base}/oracle/health`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toMatch(/rpc\.example|SECRET/);
    } finally {
      never.server.close();
    }
  });

  it('stays live without the oracle module: a stale report is checked again, once for concurrent requests (final review A8)', async () => {
    // Every feed usable at a Pyth push price (what the router serves while nothing needs a pull update).
    const oracle = Object.fromEntries(
      PRICE_SYMBOLS.map((symbol) => [
        symbol,
        {
          symbol,
          feed: { primary: { source: 1, maxAge: 3_900, id: `0x${'1'.repeat(64)}` }, secondary: null, maxConfBps: 500, maxDivergenceBps: 0 },
          ok: true,
          price: 10n ** 18n,
          validUntil: 4_000_000_000,
          lastPrice: 10n ** 18n,
          publishTime: 1,
          legs: [],
        },
      ]),
    ) as unknown as OracleState;
    let now = 1_000_000;
    let reads = 0;
    const relay = { oracle: async () => (reads++, await new Promise((r) => setTimeout(r, 20)), oracle) };
    const watchdog = new OracleWatchdog({ config: { env: 'testnet', oracleWatchMs: 30_000 }, log: () => {} } as never, relay as never, () => now);
    // AGENT_MODULES=http: no oracle loop keeps the report fresh.
    const { server, base } = await serve({ watchdog });
    try {
      expect((await fetch(`${base}/oracle/health`)).status).toBe(200);
      now += 10 * 60_000; // ten minutes later, far past two watchdog intervals
      const [a, b] = await Promise.all([fetch(`${base}/oracle/health`), fetch(`${base}/oracle/health`)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await a.json()).toMatchObject({ healthy: true, stale: false });
      expect(reads).toBe(2); // one read when there was no report, one shared by both stale requests
    } finally {
      server.close();
    }
  });

  it('lets the devnet e2e move mock prices, and nothing else', async () => {
    const calls: unknown[] = [];
    const dev = await serve({}, calls);
    try {
      const r = await fetch(`${dev.base}/oracle/admin/prices`, { method: 'POST', body: JSON.stringify({ ETH: 2_000 }) });
      expect((await r.json()).ETH).toBe(2_000);
      expect(calls).toEqual([['set', { ETH: 2_000 }]]);
    } finally {
      dev.server.close();
    }
    const test = await serve({ testnet: true });
    try {
      expect((await fetch(`${test.base}/oracle/admin/prices`, { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      test.server.close();
    }
  });
});

describe('health, status and metrics (health-monitoring-gaps)', () => {
  it('/health answers 503 when degraded; /status always 200 with the same body; /metrics is Prometheus text', async () => {
    const { server, base } = await serve({ health: { ok: false } });
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ ok: false, status: 'degraded' });
      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ ok: false, status: 'degraded' });
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
      expect(await metrics.text()).toMatch(/^# HELP mezodot_agent_up/);
      const events = await (await fetch(`${base}/events?limit=5`)).json();
      expect(events.events.map((e: { blockNumber: string }) => e.blockNumber)).toEqual(['80', '79', '78', '77', '76']);
    } finally {
      server.close();
    }
    const ok = await serve({ health: { ok: true } });
    try {
      expect((await fetch(`${ok.base}/health`)).status).toBe(200);
    } finally {
      ok.server.close();
    }
  });
});

describe('HTTP robustness (audit: agent)', () => {
  it('answers a malformed request target with 400 and keeps serving', async () => {
    const { server, port, base } = await serve();
    try {
      const reply = await rawRequest(port, 'GET http://[ HTTP/1.1');
      expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('never returns upstream error text: viem messages carry RPC URLs, and those carry API keys (rpc-url-leak)', async () => {
    const { server, base } = await serve({
      risk: {
        report: () => {
          throw LEAKY;
        },
        lastError: () => null,
      },
    });
    try {
      const res = await fetch(`${base}/risk`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'HTTP request failed.' });
    } finally {
      server.close();
    }
  });

  it('refuses an oversized /mcp body with 413 without buffering it, and keeps serving (mcp-body-dos)', async () => {
    const { MCP_BODY_LIMIT } = await import('../src/http');
    const { server, port, base } = await serve();
    try {
      // Declared too large: refused before a byte of the body is read.
      const declared = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: 'x'.repeat(MCP_BODY_LIMIT + 1),
      });
      expect(declared.status).toBe(413);
      // Streamed without a length: cut off once past the limit, long before the 8 MiB the client tries to send.
      const streamed = await streamUpload(port, 8 * 1024 * 1024);
      expect([413, -1]).toContain(streamed.status);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('turns /mcp off on a public interface without MCP_TOKEN', async () => {
    const { mcpHttpEnabled } = await import('../src/http');
    const base = loadConfig({ MEZODOT_ENV: 'devnet' });
    expect(mcpHttpEnabled(base, '127.0.0.1')).toBe(true);
    expect(mcpHttpEnabled(base, '0.0.0.0')).toBe(false);
    expect(mcpHttpEnabled(loadConfig({ MEZODOT_ENV: 'devnet', MCP_TOKEN: 'a-long-random-test-token-123' }), '0.0.0.0')).toBe(true);
  });
});
