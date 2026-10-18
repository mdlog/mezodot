import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type AgentConfig } from '../config';
import { createContext, logJson } from '../context';
import { createServices } from '../services';
import { createMcpServer } from './server';

/**
 * MCP over stdio for local agent clients (Claude Desktop, Claude Code, …), launched by bin/mcp-stdio.mjs; client
 * setup in services/agent/README.md:
 *   { "command": "node", "args": ["<repo>/services/agent/bin/mcp-stdio.mjs"], "env": { "MEZODOT_ENV": "testnet" } }
 * Logs go to stderr so stdout stays a clean JSON-RPC channel.
 *
 * This process shares STATE_DIR with a running agent, so it only reads the state files (following the agent's
 * writes) and never writes them: its own changes would otherwise overwrite the agent's cursors and messages.
 */
let config: AgentConfig;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  logJson('mcp', 'invalid configuration; not starting', { issues: err.issues });
  process.exit(1);
}
const ctx = createContext({ ...config, stateReadOnly: true });
// stdio is a local, single-client channel: MCP_ALLOW_WRITE alone gates writes.
const server = createMcpServer(createServices(ctx), { allowWrite: ctx.config.mcpAllowWrite });
await server.connect(new StdioServerTransport());
ctx.log('mcp', 'stdio server ready', { env: ctx.config.env, writes: ctx.config.mcpAllowWrite ? 'enabled' : 'dry-run only' });
