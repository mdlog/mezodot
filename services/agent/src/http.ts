import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp/server';
import { MockHermes } from './mockHermes';
import type { AgentConfig } from './config';
import { toJson, type Services } from './services';

/** Write tools over HTTP need both the explicit opt-in and a bearer token (fail closed). */
export const mcpWriteAllowed = (c: AgentConfig): boolean => c.mcpAllowWrite && c.mcpToken !== null;

function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
      if (data.length > 1_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

function send(res: ServerResponse, status: number, body: unknown, cors = true) {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(cors ? { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } : {}),
  });
  res.end(toJson(body));
}

/**
 * Read-only JSON API for the web app (CORS open), the MCP Streamable HTTP endpoint and, on the
 * devnet, a mock Hermes price service. Binds to 127.0.0.1 unless HTTP_HOST is set.
 *
 * /mcp is never exposed to browsers: no CORS preflight, DNS-rebinding protection (Host and Origin
 * allowlists) and, when MCP_TOKEN is set, a bearer token on every request. Write tools over HTTP
 * additionally require MCP_ALLOW_WRITE=true *and* a token.
 */
export function startHttp(s: Services, host = process.env.HTTP_HOST ?? '127.0.0.1') {
  const config = s.ctx.config;
  const hermes = config.env === 'devnet' ? new MockHermes(s.ctx.hub.deployment) : null;
  const allowWrite = mcpWriteAllowed(config);
  if (config.mcpAllowWrite && !allowWrite) s.ctx.log('http', 'MCP write tools disabled over HTTP: set MCP_TOKEN (>= 16 chars)');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/mcp') {
        if (req.method === 'OPTIONS') {
          res.writeHead(405).end(); // no CORS: browsers cannot be granted access to MCP
          return;
        }
        // Browsers always send Origin; native MCP clients do not. The SDK skips its Origin check when the
        // allowlist is empty, so enforce it here: no listed origin means no browser access at all.
        const origin = req.headers.origin;
        if (origin && !config.mcpAllowedOrigins.includes(origin)) {
          return send(res, 403, { error: 'Origin not allowed' }, false);
        }
        if (config.mcpToken && !bearerMatches(req.headers.authorization, config.mcpToken)) {
          return send(res, 401, { error: 'Unauthorized' }, false);
        }
        const port = (server.address() as AddressInfo).port;
        // Stateless mode: a fresh server/transport per request.
        const mcp = createMcpServer(s, { allowWrite });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, ...config.mcpAllowedHosts],
          allowedOrigins: config.mcpAllowedOrigins,
        });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'OPTIONS') return send(res, 204, '');

      if (hermes && url.pathname === '/hermes/v2/updates/price/latest') {
        return send(res, 200, hermes.latest(url.searchParams.getAll('ids[]')));
      }
      if (hermes && url.pathname === '/hermes/admin/prices' && req.method === 'POST') {
        return send(res, 200, hermes.set(JSON.parse(await readBody(req))));
      }

      switch (url.pathname) {
        case '/health':
          return send(res, 200, {
            ok: true,
            env: s.ctx.config.env,
            modules: [...s.ctx.config.modules],
            keeper: s.ctx.hub.wallet?.account.address ?? null,
            liquidatorLastRun: s.liquidator.lastRun,
          });
        case '/risk': {
          const report = s.risk.report();
          return report ? send(res, 200, report) : send(res, 503, { error: s.risk.lastError() ?? 'Risk report not ready' });
        }
        case '/stats': {
          // PRD KPI: share of borrowed value backed by collateral that lives on non-Mezo chains,
          // attributing each account's debt pro rata to its remote collateral share.
          const evals = s.liquidator.lastEvaluations;
          const debt = evals.reduce((sum, e) => sum + e.debtUsd, 0);
          const remoteBacked = evals.reduce((sum, e) => sum + (e.collateralUsd > 0 ? (e.debtUsd * e.remoteCollateralUsd) / e.collateralUsd : 0), 0);
          return send(res, 200, {
            borrowers: evals.length,
            debtUsd: debt,
            crossChainBorrowRatio: debt > 0 ? remoteBacked / debt : null,
            updatedAt: s.liquidator.lastRun,
          });
        }
        case '/messages':
          return send(
            res,
            200,
            s.relayer
              .messages()
              .slice(0, 100)
              .map(({ vaa: _vaa, ...m }) => m),
          );
        case '/liquidatable':
          return send(
            res,
            200,
            s.liquidator.lastEvaluations.filter((e) => e.healthFactor < 1.2),
          );
        default:
          return send(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(config.httpPort, host, () => s.ctx.log('http', 'listening', { host, port: (server.address() as AddressInfo).port }));
  return server;
}
