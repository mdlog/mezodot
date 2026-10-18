import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type AgentConfig } from '../config';
import { logJson } from '../context';
import { createStdioMcpServer } from './server';

/**
 * MCP over stdio for local agent clients (Claude Desktop, Claude Code, …), launched by bin/mcp-stdio.mjs; client
 * setup in services/agent/README.md:
 *   { "command": "node", "args": ["<repo>/services/agent/bin/mcp-stdio.mjs"], "env": { "MEZODOT_ENV": "testnet" } }
 * Logs go to stderr so stdout stays a clean JSON-RPC channel.
 *
 * This process shares STATE_DIR with a running agent (the launcher resolves a relative one against services/agent),
 * so it only reads the state files, following the agent's writes, and sends no keeper transaction: write tools
 * dry-run here and execute only over the agent's HTTP /mcp (see createStdioMcpServer).
 */
let config: AgentConfig;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  logJson('mcp', 'invalid configuration; not starting', { issues: err.issues });
  process.exit(1);
}
const { ctx, server } = createStdioMcpServer(config);
await server.connect(new StdioServerTransport());
ctx.log('mcp', 'stdio server ready', { env: ctx.config.env, stateDir: ctx.config.stateDir, writes: 'dry-run only (they execute over the agent HTTP /mcp)' });
