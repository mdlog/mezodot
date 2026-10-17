import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NETWORKS } from '@mezodot/sdk';
import { toJson, type Services } from '../services';
import { createTools, type ToolOptions } from './tools';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: toJson(value) }] });

/** MCP server exposing Mezodot market data, risk analytics and keeper actions to AI agents. */
export function createMcpServer(services: Services, opts: ToolOptions): McpServer {
  const tools = createTools(services, opts);
  const server = new McpServer({ name: 'mezodot', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  server.registerTool(
    'get_markets',
    {
      title: 'Markets',
      description: 'MUSD/MEZO pools: supply, borrows, utilization, APYs, pToken exchange rates and collateral risk parameters.',
      annotations: readOnly,
    },
    async () => text(await tools.get_markets()),
  );

  server.registerTool(
    'get_position',
    {
      title: 'Position',
      description: 'Cross-chain collateral, debts and health factor of an account, valued with fresh Pyth prices.',
      inputSchema: { address: z.string().describe('EVM address of the account') },
      annotations: readOnly,
    },
    async (args) => text(await tools.get_position(args)),
  );

  server.registerTool(
    'get_risk_report',
    {
      title: 'Risk report',
      description: 'Volatility, VaR, recommended LTVs, walk-forward leverage tests with Deflated Sharpe Ratio, and loop carry.',
      annotations: readOnly,
    },
    async () => text(await tools.get_risk_report()),
  );

  server.registerTool(
    'simulate_loop',
    {
      title: 'Simulate loop',
      description: 'Preview a 1-click MUSD → pMUSD loop: flash amount, fee, debt, LTV, health factor, net APY.',
      inputSchema: { principal: z.number().positive(), leverage: z.number().gt(1).lte(10) },
      annotations: readOnly,
    },
    async (args) => text(await tools.simulate_loop(args)),
  );

  server.registerTool(
    'simulate_borrow',
    {
      title: 'Simulate borrow',
      description: 'Health factor of an account after borrowing an amount of MUSD or MEZO.',
      inputSchema: { address: z.string(), market: z.enum(['MUSD', 'MEZO']), amount: z.number().positive() },
      annotations: readOnly,
    },
    async (args) => text(await tools.simulate_borrow(args)),
  );

  server.registerTool(
    'list_liquidatable',
    {
      title: 'Liquidatable accounts',
      description: 'Accounts with health factor below 1 and the planned liquidation (repay, seize, profit).',
      annotations: readOnly,
    },
    async () => text(await tools.list_liquidatable()),
  );

  server.registerTool(
    'list_pending_messages',
    { title: 'Pending cross-chain messages', description: 'Wormhole DEPOSIT/RELEASE messages observed but not yet delivered.', annotations: readOnly },
    async () => text(await tools.list_pending_messages()),
  );

  server.registerTool(
    'trigger_liquidation',
    {
      title: 'Trigger liquidation',
      description:
        'Liquidate an unhealthy account via KeeperGateway. Dry-run by default; executes only with dry_run=false and MCP_ALLOW_WRITE=true on the agent.',
      inputSchema: { address: z.string(), dry_run: z.boolean().default(true), force: z.boolean().default(false).describe('ignore MIN_PROFIT_USD') },
      annotations: write,
    },
    async (args) => text(await tools.trigger_liquidation(args)),
  );

  server.registerTool(
    'relay_message',
    {
      title: 'Relay message',
      description: 'Deliver a pending Wormhole message (id from list_pending_messages). Dry-run by default.',
      inputSchema: { id: z.string(), dry_run: z.boolean().default(true) },
      annotations: write,
    },
    async (args) => text(await tools.relay_message(args)),
  );

  server.registerResource(
    'deployment',
    'mezodot://deployment',
    { title: 'Deployment', description: 'Contract addresses for the hub and spokes', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: toJson({
            env: services.ctx.config.env,
            hub: { label: NETWORKS[services.ctx.hub.network].label, ...services.ctx.hub.deployment },
            spokes: services.ctx.spokes.map((sp) => ({ label: NETWORKS[sp.network].label, ...sp.deployment })),
          }),
        },
      ],
    }),
  );

  return server;
}
