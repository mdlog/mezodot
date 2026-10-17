import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config';
import { createContext } from '../context';
import { createServices } from '../services';
import { createMcpServer } from './server';

/**
 * MCP over stdio for local agent clients (e.g. Claude Desktop / Claude Code):
 *   { "command": "pnpm", "args": ["--filter", "@mezodot/agent", "mcp"], "env": { "MEZODOT_ENV": "testnet" } }
 * Logs go to stderr so stdout stays a clean JSON-RPC channel.
 */
const ctx = createContext(loadConfig());
// stdio is a local, single-client channel: MCP_ALLOW_WRITE alone gates writes.
const server = createMcpServer(createServices(ctx), { allowWrite: ctx.config.mcpAllowWrite });
await server.connect(new StdioServerTransport());
ctx.log('mcp', 'stdio server ready', { env: ctx.config.env });
