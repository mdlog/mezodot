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
    const server = createMcpServer(fakeServices(false));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_markets', 'get_position', 'get_risk_report', 'list_liquidatable', 'list_pending_messages', 'relay_message', 'simulate_borrow', 'simulate_loop', 'trigger_liquidation']);
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
    const locked = createTools(fakeServices(false, relayed));
    expect((await locked.relay_message({ id: message.id })).executed).toBe(false);
    expect((await locked.relay_message({ id: message.id, dry_run: false })).reason).toMatch(/MCP_ALLOW_WRITE/);
    expect(relayed).toEqual([]);

    const open = createTools(fakeServices(true, relayed));
    expect((await open.relay_message({ id: message.id, dry_run: true })).executed).toBe(false);
    expect((await open.relay_message({ id: message.id, dry_run: false })).executed).toBe(true);
    expect(relayed).toEqual([message.id]);
  });

  it('rejects invalid addresses', async () => {
    const tools = createTools(fakeServices(false));
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
    const tools = createTools(fakeServices(false));
    const { markets, collaterals } = await tools.get_markets();
    expect(markets.map((m) => m.market)).toEqual(['MUSD', 'MEZO']);
    expect(collaterals.map((c) => c.symbol)).toEqual(['pMUSD', 'pMEZO', 'WETH', 'USDC']);
    const plan = await tools.simulate_loop({ principal: 1_000, leverage: 3 });
    expect(plan.debt).toBeCloseTo(2_001.8, 9);
    expect(plan.healthFactor).toBeCloseTo((3_000 * 0.85) / 2_001.8, 9);
  });
});
