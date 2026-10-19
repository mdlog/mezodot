#!/usr/bin/env node
// `mezodot-mcp`: the Mezodot MCP server over stdio (src/mcp/stdio.ts) for MCP clients that launch a command.
// Reads services/agent/.env like `pnpm mcp` does; variables already set in the environment (e.g. the client's
// "env" block) win. Nothing but JSON-RPC is written to stdout.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const agentDir = fileURLToPath(new URL('..', import.meta.url));
const envFile = resolve(agentDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
// MCP clients start this in their own working directory, while `pnpm start` runs the agent in services/agent: a
// relative STATE_DIR (the default `.state` included) is the agent's, so the server follows the agent's state files.
process.env.STATE_DIR = resolve(agentDir, process.env.STATE_DIR?.trim() || '.state');
register();
await import('../src/mcp/stdio.ts');
