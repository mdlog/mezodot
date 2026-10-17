import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp/server';
import { MockHermes } from './mockHermes';
import { toJson, type Services } from './services';

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
 * Read-only JSON API for the web app (CORS open), the MCP Streamable HTTP endpoint (/mcp,
 * same-origin only) and, on the devnet, a mock Hermes price service.
 * Binds to 127.0.0.1 unless HTTP_HOST is set (e.g. 0.0.0.0 inside Docker).
 */
export function startHttp(s: Services, host = process.env.HTTP_HOST ?? '127.0.0.1') {
  const hermes = s.ctx.config.env === 'devnet' ? new MockHermes(s.ctx.hub.deployment) : null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');

      if (url.pathname === '/mcp') {
        // Stateless mode: a fresh server/transport per request.
        const mcp = createMcpServer(s);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
        await transport.handleRequest(req, res, body);
        return;
      }

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
          return send(res, 200, s.relayer.messages().slice(0, 100).map(({ vaa: _vaa, ...m }) => m));
        case '/liquidatable':
          return send(res, 200, s.liquidator.lastEvaluations.filter((e) => e.healthFactor < 1.2));
        default:
          return send(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(s.ctx.config.httpPort, host, () => s.ctx.log('http', 'listening', { host, port: s.ctx.config.httpPort }));
  return server;
}
