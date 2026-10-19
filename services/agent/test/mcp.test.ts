import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPublicClient, http } from 'viem';
import { PRICE_KEYS, devnetHub, getHubDeployment, getSpokeDeployment, type ProtocolState } from '@mezodot/sdk';
import { loadConfig } from '../src/config';
import { createContext } from '../src/context';
import { STDIO_WRITES_OFF, createMcpServer, createStdioMcpServer } from '../src/mcp/server';
import { collateralDecimals, createTools, describeCollaterals } from '../src/mcp/tools';
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

function fakeServices(allowWrite: boolean, relayed: string[] = [], logs: unknown[] = []): Services {
  const ctx = createContext(
    loadConfig({ MEZODOT_ENV: 'devnet', MCP_ALLOW_WRITE: String(allowWrite), STATE_DIR: '/tmp/mezodot-test-state' }),
    (_scope, message, extra) => logs.push({ message, ...extra }),
  );
  return {
    ctx,
    relayer: {
      messages: () => [message],
      pending: () => [message],
      isStuck: () => false,
      relay: async (id: string) => {
        relayed.push(id);
        return { ...message, status: 'delivered' };
      },
    },
    liquidator: {},
    risk: { report: () => null, refresh: async () => null, lastError: () => 'offline' },
    revenue: {
      report: () => null,
      refresh: async () => {
        throw new Error('HTTP request failed.\n\nURL: https://rpc.example/v2/SECRET_API_KEY_123');
      },
    },
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
      'get_oracle_health',
      'get_position',
      'get_revenue',
      'get_risk_report',
      'list_liquidatable',
      'list_pending_messages',
      'relay_message',
      'simulate_borrow',
      'simulate_btc_close',
      'simulate_btc_leverage',
      'simulate_loop',
      'trigger_liquidation',
    ]);
    expect(tools.find((t) => t.name === 'trigger_liquidation')?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'get_markets')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'simulate_btc_leverage')?.annotations?.readOnlyHint).toBe(true);

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

  it('reports a message archived during a manual relay instead of crashing (final review V2)', async () => {
    const services = fakeServices(true);
    services.relayer.relay = async () => null;
    const tools = createTools(services, { allowWrite: true });
    const result = await tools.relay_message({ id: message.id, dry_run: false });
    expect(result).toMatchObject({ executed: false, reason: expect.stringMatching(/archived as undeliverable/) });
    expect(result.message).not.toHaveProperty('vaa'); // VAA bytes are still not returned
  });

  it('rejects invalid addresses', async () => {
    const tools = createTools(fakeServices(false), { allowWrite: false });
    await expect(tools.get_position({ address: 'not-an-address' })).rejects.toThrow(/Invalid address/);
  });

  it('turns tool failures into one-line errors without RPC URLs (rpc-url-leak)', async () => {
    const logs: unknown[] = [];
    const server = createMcpServer(fakeServices(false, [], logs), { allowWrite: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: 'get_revenue', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toBe('HTTP request failed.');
    expect(JSON.stringify(logs)).not.toMatch(/SECRET|rpc\.example/);
    await client.close();
  });
});

describe('MCP numbers (mcp-btc-numbers)', () => {
  const protocol = {
    markets: [{ id: 0, symbol: 'MUSD', pool: '0x00000000000000000000000000000000000000a1', decimals: 18, shareDecimals: 24 }],
    collaterals: [
      {
        id: 0,
        symbol: 'pMUSD',
        isShare: true,
        isRemote: false,
        token: '0x00000000000000000000000000000000000000A1',
        decimals: 18,
        bonusBps: 500,
        ltvBps: 8000,
        ltBps: 8500,
        cap: 0n,
        total: 10n ** 24n,
        enabled: true,
        chainId: 0,
        priceKey: PRICE_KEYS.MUSD,
      },
      {
        id: 1,
        symbol: 'BTC',
        isShare: false,
        isRemote: false,
        token: '0x7b7C000000000000000000000000000000000000',
        decimals: 18,
        bonusBps: 500,
        ltvBps: 7000,
        ltBps: 7800,
        cap: 10n ** 19n,
        total: 10n ** 18n,
        enabled: true,
        chainId: 0,
        priceKey: PRICE_KEYS.BTC,
      },
      {
        id: 2,
        symbol: 'USDC',
        isShare: false,
        isRemote: true,
        token: '0x0000000000000000000000000000000000000000',
        decimals: 6,
        bonusBps: 500,
        ltvBps: 8000,
        ltBps: 8500,
        cap: 0n,
        total: 2_500_000n,
        enabled: true,
        chainId: 10004,
        priceKey: PRICE_KEYS.USDC,
      },
    ],
    liquidationFeeBps: 1_000,
  } as unknown as ProtocolState;

  it('formats BTC as an 18-decimal token, pTokens as 24-decimal shares and spoke USDC with 6 decimals', () => {
    expect(protocol.collaterals.map((c) => collateralDecimals(protocol, c))).toEqual([24, 18, 6]);
    const rows = describeCollaterals(protocol);
    expect(rows.map((r) => r.totalPosted)).toEqual(['1', '1', '2.5']); // 1 BTC, not 0.000001
    expect(rows[1].cap).toBe('10');
    expect(describeCollaterals({ ...protocol, collaterals: [{ ...protocol.collaterals[1], cap: 2n ** 256n - 1n }] }).map((r) => r.cap)).toEqual([null]); // unlimited
    expect(rows[0].cap).toBe('0'); // a zero cap admits nothing
  });

  it('publishes the bonus a liquidator keeps after the protocol fee next to the gross one', () => {
    const btc = describeCollaterals(protocol)[1];
    expect(btc.liquidationBonus).toBeCloseTo(0.05, 12);
    expect(btc.liquidatorBonus).toBeCloseTo(0.045, 12);
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
    // DeployHub lists the hub collateral (pMUSD, pMEZO, BTC); ConfigureCrossChain adds the spoke tokens.
    expect(collaterals.map((c) => c.symbol)).toEqual(['pMUSD', 'pMEZO', 'BTC', 'WETH', 'USDC']);
    expect(collaterals.find((c) => c.symbol === 'BTC')?.kind).toBe('token');
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

describe('the stdio MCP server (final review A3, F8)', () => {
  /** Anvil's well-known test key #1. */
  const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));

  it('never sends keeper transactions, whatever MCP_ALLOW_WRITE says: no senders, and its write tools dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mezodot-stdio-'));
    const hub = getHubDeployment('devnet-hub')!;
    const spoke = getSpokeDeployment('devnet-spoke')!;
    // A message the running agent has pending, in the state directory both processes use.
    const pending = { ...message, emitter: spoke.contracts.spokeGateway, targetContract: hub.contracts.wormholeAdapter };
    writeFileSync(
      join(dir, 'relayer-devnet.json'),
      JSON.stringify({ cursors: {}, sequences: {}, messages: { [message.id]: { ...pending, sequence: { $bigint: '1' }, blockNumber: { $bigint: '1' } } } }),
    );
    const logs: string[] = [];
    const config = loadConfig({ MEZODOT_ENV: 'devnet', MCP_ALLOW_WRITE: 'true', KEEPER_PRIVATE_KEY: KEY, STATE_DIR: dir });
    const { ctx, server } = createStdioMcpServer(config, (_scope, m) => logs.push(m));
    expect(ctx.config.stateReadOnly).toBe(true);
    expect(ctx.hub.wallet).not.toBeNull(); // dry runs still simulate from the keeper's address
    expect([ctx.hub.sender, ...ctx.spokes.map((sp) => sp.sender)]).toEqual([null, null]);
    expect(logs).toContain(`MCP_ALLOW_WRITE is ignored over stdio: ${STDIO_WRITES_OFF}`);

    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: 'relay_message', arguments: { id: message.id, dry_run: false } });
    expect(JSON.parse((res.content as { text: string }[])[0].text)).toMatchObject({ executed: false, reason: STDIO_WRITES_OFF });
    await client.close();
  });

  it('follows the agent state in services/agent/.state, whatever directory the MCP client starts it in', async () => {
    // The launcher, copied next to the real sources and modules (and without the package's .env).
    const pkg = mkdtempSync(join(tmpdir(), 'mezodot-launcher-'));
    mkdirSync(join(pkg, 'bin'));
    copyFileSync(join(AGENT_DIR, 'bin/mcp-stdio.mjs'), join(pkg, 'bin/mcp-stdio.mjs'));
    symlinkSync(join(AGENT_DIR, 'src'), join(pkg, 'src'));
    symlinkSync(join(AGENT_DIR, 'node_modules'), join(pkg, 'node_modules'));
    const clientCwd = mkdtempSync(join(tmpdir(), 'mezodot-client-'));
    const child = spawn(process.execPath, [join(pkg, 'bin/mcp-stdio.mjs')], {
      cwd: clientCwd,
      env: { PATH: process.env.PATH, MEZODOT_ENV: 'devnet' },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    try {
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`no ready line: ${stderr}`)), 25_000);
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          for (const line of stderr.split('\n')) {
            if (!line.includes('stdio server ready')) continue;
            clearTimeout(timer);
            resolve(JSON.parse(line) as Record<string, unknown>);
          }
        });
        child.on('exit', (code) => reject(new Error(`exited with ${code}: ${stderr}`)));
      });
      expect(ready.stateDir).toBe(join(pkg, '.state'));
    } finally {
      child.kill();
    }
  }, 30_000);
});
