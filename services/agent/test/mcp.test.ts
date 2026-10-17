import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPublicClient, http } from 'viem';
import { devnetHub, getHubDeployment } from '@mezodot/sdk';
import { loadConfig } from '../src/config';
import { createContext } from '../src/context';
import { createMcpServer } from '../src/mcp/server';
import { createTools } from '../src/mcp/tools';
import type { Services } from '../src/services';
import type { RelayMessage } from '../src/relayer';

const message: RelayMessage = {
  id: '10004/0xabc/1',
  direction: 'deposit',
  source: 'devnet-spoke',
  target: 'devnet-hub',
  emitterChain: 10004,
  emitter: '0x0000000000000000000000000000000000000abc',
  sequence: 1n,
  txHash: '0x01',
  blockNumber: 1n,
  status: 'ready',
  attempts: 0,
  observedAt: 0,
  vaa: '0xdead',
};

function fakeServices(allowWrite: boolean, relayed: string[] = []): Services {
  const ctx = createContext(loadConfig({ MEZODOT_ENV: 'devnet', MCP_ALLOW_WRITE: String(allowWrite), STATE_DIR: '/tmp/mezodot-test-state' }));
  return {
    ctx,
    relayer: {
      messages: () => [message],
      pending: () => [message],
      relay: async (id: string) => {
        relayed.push(id);
        return { ...message, status: 'delivered' };
      },
    },
    liquidator: {},
    risk: { report: () => null, refresh: async () => null, lastError: () => 'offline' },
  } as unknown as Services;
}

describe('MCP server', () => {
  it('exposes the documented tools with read/write annotations', async () => {
    const server = createMcpServer(fakeServices(false), { allowWrite: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_markets',
      'get_position',
      'get_risk_report',
      'list_liquidatable',
      'list_pending_messages',
      'relay_message',
      'simulate_borrow',
      'simulate_loop',
      'trigger_liquidation',
    ]);
    expect(tools.find((t) => t.name === 'trigger_liquidation')?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'get_markets')?.annotations?.readOnlyHint).toBe(true);

    const pending = await client.callTool({ name: 'list_pending_messages', arguments: {} });
    const text = (pending.content as { text: string }[])[0].text;
    expect(text).toContain('10004/0xabc/1');
    expect(text).not.toContain('0xdead'); // VAA bytes are not dumped
    await client.close();
  });

  it('write tools dry-run by default and require MCP_ALLOW_WRITE', async () => {
    const relayed: string[] = [];
    const locked = createTools(fakeServices(false, relayed), { allowWrite: false });
    expect((await locked.relay_message({ id: message.id })).executed).toBe(false);
    expect((await locked.relay_message({ id: message.id, dry_run: false })).reason).toMatch(/writes disabled/);
    expect(relayed).toEqual([]);

    const open = createTools(fakeServices(true, relayed), { allowWrite: true });
    expect((await open.relay_message({ id: message.id, dry_run: true })).executed).toBe(false);
    expect((await open.relay_message({ id: message.id, dry_run: false })).executed).toBe(true);
    expect(relayed).toEqual([message.id]);
  });

  it('rejects invalid addresses', async () => {
    const tools = createTools(fakeServices(false), { allowWrite: false });
    await expect(tools.get_position({ address: 'not-an-address' })).rejects.toThrow(/Invalid address/);
  });
});

// Runs against the local devnet when it is up (scripts/devnet/start.sh).
const devnetUp = await createPublicClient({ chain: devnetHub, transport: http() })
  .getChainId()
  .then(() => getHubDeployment('devnet-hub') !== null)
  .catch(() => false);

describe.skipIf(!devnetUp)('MCP tools on the devnet', () => {
  it('get_markets and simulate_loop read live contracts', async () => {
    const tools = createTools(fakeServices(false), { allowWrite: false });
    const { markets, collaterals } = await tools.get_markets();
    expect(markets.map((m) => m.market)).toEqual(['MUSD', 'MEZO']);
    expect(collaterals.map((c) => c.symbol)).toEqual(['pMUSD', 'pMEZO', 'WETH', 'USDC']);
    const plan = await tools.simulate_loop({ principal: 1_000, leverage: 3 });
    expect(plan.debt).toBeCloseTo(2_001.8, 9);
    expect(plan.healthFactor).toBeCloseTo((3_000 * 0.85) / 2_001.8, 9);
  });
});

describe('MCP over HTTP is not reachable from arbitrary web pages (final review M2)', () => {
  async function serve(env: Record<string, string>) {
    const { startHttp } = await import('../src/http');
    const ctx = createContext(loadConfig({ MEZODOT_ENV: 'devnet', STATE_DIR: '/tmp/mezodot-test-state', HTTP_PORT: '0', ...env }));
    const services = {
      ctx,
      relayer: { messages: () => [], pending: () => [] },
      liquidator: { lastEvaluations: [], lastRun: null },
      risk: { report: () => null, lastError: () => null },
    } as unknown as Services;
    const server = startHttp(services, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;
    return { server, base: `http://127.0.0.1:${port}` };
  }
  const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  it('answers CORS preflight for read endpoints but not for /mcp', async () => {
    const { server, base } = await serve({});
    try {
      const health = await fetch(`${base}/health`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
      expect(health.headers.get('access-control-allow-origin')).toBe('*');
      const mcp = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
      expect(mcp.headers.get('access-control-allow-origin')).toBeNull();
      expect(mcp.status).toBe(405);
    } finally {
      server.close();
    }
  });

  it('rejects cross-origin and rebinding requests to /mcp', async () => {
    const { server, base } = await serve({});
    try {
      const evil = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...mcpHeaders, origin: 'https://evil.example' }, body: listTools });
      expect(evil.status).toBe(403);
      const ok = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: listTools });
      expect(ok.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('requires the bearer token when MCP_TOKEN is set', async () => {
    const { server, base } = await serve({ MCP_TOKEN: 'a-long-random-test-token-123' });
    try {
      expect((await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: listTools })).status).toBe(401);
      expect(
        (await fetch(`${base}/mcp`, { method: 'POST', headers: { ...mcpHeaders, authorization: 'Bearer wrong-token-of-same-size-12' }, body: listTools }))
          .status,
      ).toBe(401);
      const ok = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...mcpHeaders, authorization: 'Bearer a-long-random-test-token-123' },
        body: listTools,
      });
      expect(ok.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('keeps HTTP writes disabled unless a token is configured', async () => {
    const { mcpWriteAllowed } = await import('../src/http');
    expect(mcpWriteAllowed(loadConfig({ MEZODOT_ENV: 'devnet', MCP_ALLOW_WRITE: 'true' }))).toBe(false);
    expect(mcpWriteAllowed(loadConfig({ MEZODOT_ENV: 'devnet', MCP_ALLOW_WRITE: 'true', MCP_TOKEN: 'a-long-random-test-token-123' }))).toBe(true);
    expect(mcpWriteAllowed(loadConfig({ MEZODOT_ENV: 'devnet', MCP_TOKEN: 'a-long-random-test-token-123' }))).toBe(false);
  });
});
