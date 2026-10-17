import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { PriceSymbol } from '@mezodot/sdk';
import { loadConfig } from '../src/config';
import { createContext } from '../src/context';
import type { Services } from '../src/services';

/** Devnet context (the testnet hub is not deployed yet); `testnet: true` only flips the env flag. */
async function serve(opts: { testnet?: boolean }, calls: unknown[] = []) {
  const { startHttp } = await import('../src/http');
  const ctx = createContext(loadConfig({ MEZODOT_ENV: 'devnet', STATE_DIR: '/tmp/mezodot-test-state', HTTP_PORT: '0' }));
  if (opts.testnet) ctx.config.env = 'testnet';
  const services = {
    ctx,
    relayer: { messages: () => [], pending: () => [] },
    liquidator: { lastEvaluations: [], lastRun: null },
    risk: { report: () => null, lastError: () => null },
    oracle: {
      update: async (symbols: PriceSymbol[]) => {
        calls.push(['update', symbols]);
        if (symbols.includes('USDC')) throw new Error('Supra proof service error 502');
        return { updates: ['0x02ab'], prices: { ETH: { price: 2_412.98, publishTime: 1, source: 'supra' } }, missing: [] };
      },
      setMockPrices: (p: Record<string, number>) => (calls.push(['set', p]), { MUSD: 1, MEZO: 0.008, ETH: p.ETH ?? 3_200, USDC: 1 }),
    },
    watchdog: { report: () => ({ checkedAt: 1, healthy: true, feeds: [] }), check: async () => ({ checkedAt: 2, healthy: true, feeds: [] }) },
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

  it('reports oracle health', async () => {
    const { server, base } = await serve({});
    try {
      expect(await (await fetch(`${base}/oracle/health`)).json()).toEqual({ checkedAt: 1, healthy: true, feeds: [] });
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

describe('HTTP robustness (audit: agent)', () => {
  it('answers a malformed request target with 400 and keeps serving', async () => {
    const { server, port, base } = await serve({});
    try {
      const reply = await rawRequest(port, 'GET http://[ HTTP/1.1');
      expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
