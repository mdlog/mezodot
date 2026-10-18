#!/usr/bin/env node
// `mezodot-mcp`: the Mezodot MCP server over stdio (src/mcp/stdio.ts) for MCP clients that launch a command.
// Reads services/agent/.env like `pnpm mcp` does; variables already set in the environment (e.g. the client's
// "env" block) win. Nothing but JSON-RPC is written to stdout.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
register();
await import('../src/mcp/stdio.ts');
