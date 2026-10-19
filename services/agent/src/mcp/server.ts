import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { NETWORKS } from '@mezodot/sdk';
import type { AgentConfig } from '../config';
import { createContext, type Context, type Logger } from '../context';
import { publicError } from '../errors';
import { createServices, toJson, type Services } from '../services';
import { createTools, type ToolOptions } from './tools';

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: toJson(value) }] });

/** Why write tools never execute over stdio. */
export const STDIO_WRITES_OFF =
  'write tools execute only in the running agent, over its HTTP /mcp: this stdio server follows the agent state read-only and could not record what a keeper transaction changes';

/**
 * The MCP server for stdio clients (src/mcp/stdio.ts). It shares STATE_DIR with a running agent, so it only reads
 * the state files (following the agent's writes) and has no keeper senders: write tools dry-run whatever
 * MCP_ALLOW_WRITE says (a second sender on the key would also race the agent for nonces).
 */
export function createStdioMcpServer(config: AgentConfig, log?: Logger): { ctx: Context; server: McpServer } {
  const ctx = createContext({ ...config, stateReadOnly: true }, log);
  if (config.mcpAllowWrite) ctx.log('mcp', `MCP_ALLOW_WRITE is ignored over stdio: ${STDIO_WRITES_OFF}`);
  return { ctx, server: createMcpServer(createServices(ctx), { allowWrite: false, writesOff: STDIO_WRITES_OFF }) };
}

/** MCP server exposing Mezodot market data, risk analytics and keeper actions to AI agents. */
export function createMcpServer(services: Services, opts: ToolOptions): McpServer {
  const tools = createTools(services, opts);
  const server = new McpServer({ name: 'mezodot', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  /**
   * Runs a tool and turns a failure into a tool error with a one-line, URL-free message: viem errors embed the
   * RPC URL (which can carry an API key) and the MCP SDK would otherwise return error.message verbatim.
   */
  const run = async (tool: string, fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return text(await fn());
    } catch (err) {
      const error = publicError(err);
      services.ctx.log('mcp', 'tool failed', { tool, error });
      return { isError: true, content: [{ type: 'text', text: error }] };
    }
  };

  server.registerTool(
    'get_markets',
    {
      title: 'Markets',
      description:
        'MUSD/MEZO pools (supply, borrows, idle cash, utilization, APYs, pToken exchange rates, reserve factor and reserves) and collateral risk parameters, including the liquidation bonus a liquidator keeps after the protocol fee.',
      annotations: readOnly,
    },
    () => run('get_markets', () => tools.get_markets()),
  );

  server.registerTool(
    'get_position',
    {
      title: 'Position',
      description:
        'Cross-chain collateral, debts and health factor of an account, valued at the prices the protocol would accept now (Pyth on Mezo, Supra pull for ETH/USDC/BTC). Balances are in token units (pToken shares for pMUSD/pMEZO).',
      inputSchema: { address: z.string().describe('EVM address of the account') },
      annotations: readOnly,
    },
    (args) => run('get_position', () => tools.get_position(args)),
  );

  server.registerTool(
    'get_oracle_health',
    {
      title: 'Oracle health',
      description:
        'Per price feed: sources (Pyth push / Supra pull), age, how long it stays valid, and whether risk checks touching it would pass, need a pull update, or revert. Says when the report is stale.',
      annotations: readOnly,
    },
    () => run('get_oracle_health', () => tools.get_oracle_health()),
  );

  server.registerTool(
    'get_risk_report',
    {
      title: 'Risk report',
      description:
        'Volatility, VaR over the liquidation horizon, DEX liquidity haircuts, recommended LTVs, walk-forward leverage tests with Deflated Sharpe Ratio, and loop carry.',
      annotations: readOnly,
    },
    () => run('get_risk_report', () => tools.get_risk_report()),
  );

  server.registerTool(
    'get_revenue',
    {
      title: 'Protocol revenue',
      description:
        "Protocol revenue as it accrues on-chain: pool reserves (reserve factor on interest plus the 0.09% flash fee), lifetime flash fees and reserve withdrawals, and the treasury's share of liquidation bonuses held as collateral in VaultManager custody.",
      annotations: readOnly,
    },
    () => run('get_revenue', () => tools.get_revenue()),
  );

  server.registerTool(
    'simulate_loop',
    {
      title: 'Simulate loop',
      description:
        'Preview a 1-click MUSD → pMUSD loop priced at the state it leaves the pool in: flash amount and fee, debt, health factor, net APY against plain supply (the loop is negative carry by construction), pool liquidity and caps; with `address`, the whole account after the loop.',
      inputSchema: {
        principal: z.number().positive(),
        leverage: z.number().gt(1).lte(10),
        address: z.string().optional().describe('account that opens the loop (its existing collateral and debt count)'),
      },
      annotations: readOnly,
    },
    (args) => run('simulate_loop', () => tools.simulate_loop(args)),
  );

  server.registerTool(
    'simulate_btc_leverage',
    {
      title: 'Simulate BTC leverage',
      description:
        'Preview SwapLeverageManager.open: `principal` BTC taken to `leverage`× by a Tigris flash swap paid with borrowed MUSD (no flash fee). Live pool quote vs oracle, minimum BTC bought, debt, health factor, liquidation price, MUSD pool idle cash, carry; with `address`, the whole account after the open.',
      inputSchema: {
        principal: z.number().positive().describe('BTC the account adds'),
        leverage: z.number().gt(1).lte(10),
        slippage_bps: z.number().int().min(0).max(5_000).optional().describe('accepted swap slippage (default 100 = 1%)'),
        address: z.string().optional().describe('account that opens the position (its existing collateral and debt count)'),
      },
      annotations: readOnly,
    },
    (args) => run('simulate_btc_leverage', () => tools.simulate_btc_leverage(args)),
  );

  server.registerTool(
    'simulate_btc_close',
    {
      title: 'Simulate BTC close',
      description:
        "Preview SwapLeverageManager.close of an account's whole BTC position: BTC sold on Tigris to repay the MUSD debt (clamped to the live debt, no pool cash needed), minimum proceeds, collateral returned, and the pool-vs-oracle price gap.",
      inputSchema: {
        address: z.string().describe('EVM address of the account'),
        slippage_bps: z.number().int().min(0).max(5_000).optional().describe('accepted swap slippage (default 100 = 1%)'),
      },
      annotations: readOnly,
    },
    (args) => run('simulate_btc_close', () => tools.simulate_btc_close(args)),
  );

  server.registerTool(
    'simulate_borrow',
    {
      title: 'Simulate borrow',
      description: 'Health factor of an account after borrowing an amount of MUSD or MEZO.',
      inputSchema: { address: z.string(), market: z.enum(['MUSD', 'MEZO']), amount: z.number().positive() },
      annotations: readOnly,
    },
    (args) => run('simulate_borrow', () => tools.simulate_borrow(args)),
  );

  server.registerTool(
    'list_liquidatable',
    {
      title: 'Liquidatable accounts',
      description:
        'Accounts with health factor below 1, the planned liquidation (repay, seize, oracle-valued profit) and the keeper assessment: profit at the realisable price (Tigris for BTC) net of gas and fees, and whether it liquidates, holds or skips.',
      annotations: readOnly,
    },
    () => run('list_liquidatable', () => tools.list_liquidatable()),
  );

  server.registerTool(
    'list_pending_messages',
    {
      title: 'Pending cross-chain messages',
      description: 'Wormhole DEPOSIT/RELEASE messages observed but not yet delivered, with their age and whether they are stuck.',
      annotations: readOnly,
    },
    () => run('list_pending_messages', () => tools.list_pending_messages()),
  );

  server.registerTool(
    'trigger_liquidation',
    {
      title: 'Trigger liquidation',
      description:
        'Liquidate an unhealthy account via KeeperGateway, on the pair the keeper can realise best. Dry-run by default; executes only with dry_run=false and MCP_ALLOW_WRITE=true, over the agent HTTP /mcp (never over stdio).',
      inputSchema: { address: z.string(), dry_run: z.boolean().default(true), force: z.boolean().default(false).describe('ignore MIN_PROFIT_USD') },
      annotations: write,
    },
    (args) => run('trigger_liquidation', () => tools.trigger_liquidation(args)),
  );

  server.registerTool(
    'relay_message',
    {
      title: 'Relay message',
      description:
        'Deliver a pending Wormhole message (id from list_pending_messages). Dry-run by default; executes like trigger_liquidation (agent HTTP /mcp only).',
      inputSchema: { id: z.string(), dry_run: z.boolean().default(true) },
      annotations: write,
    },
    (args) => run('relay_message', () => tools.relay_message(args)),
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
