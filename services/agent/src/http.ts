import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PRICE_SYMBOLS, type PriceSymbol } from '@mezodot/sdk';
import { createMcpServer } from './mcp/server';
import { isLoopbackHost, type AgentConfig } from './config';
import { publicError } from './errors';
import { toJson, type Services } from './services';

/** Write tools over HTTP need both the explicit opt-in and a bearer token (fail closed). */
export const mcpWriteAllowed = (c: AgentConfig): boolean => c.mcpAllowWrite && c.mcpToken !== null;

/** /mcp on a non-loopback interface needs MCP_TOKEN: otherwise anyone who reaches the port could use it. */
export const mcpHttpEnabled = (c: AgentConfig, host: string): boolean => c.mcpToken !== null || isLoopbackHost(host);

/** Largest /mcp request body; MCP requests are small JSON-RPC messages. */
export const MCP_BODY_LIMIT = 512 * 1024;
const ADMIN_BODY_LIMIT = 16 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Reads a request body of at most `limit` bytes. Past the limit it stops reading and rejects with 413; the caller
 * answers and closes the connection, so an oversized upload is never buffered.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new HttpError(413, `Body larger than ${limit} bytes`));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        reject(new HttpError(413, `Body larger than ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseJson(raw: string): unknown {
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };

function send(res: ServerResponse, status: number, body: unknown, cors = true, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...(cors ? CORS : {}), ...headers });
  res.end(toJson(body));
}

/** `?symbols=ETH,USDC` → known symbols in canonical order; null when empty or unknown. */
function parseSymbols(raw: string | null): PriceSymbol[] | null {
  const asked = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (asked.length === 0 || asked.some((s) => !(PRICE_SYMBOLS as readonly string[]).includes(s))) return null;
  return PRICE_SYMBOLS.filter((s) => asked.includes(s));
}

const clampInt = (raw: string | null, fallback: number, min: number, max: number) => {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Read-only JSON API for the web app (CORS open), the oracle relay (signed Supra proofs; nothing secret), health
 * and metrics for operators, and the MCP Streamable HTTP endpoint. Binds to 127.0.0.1 unless HTTP_HOST is set.
 *
 * /mcp is never exposed to browsers: no CORS preflight, Host and Origin allowlists checked before the body is
 * read, a capped body, and a bearer token on every request when MCP_TOKEN is set (required when HTTP_HOST is not
 * loopback). Write tools over HTTP additionally require MCP_ALLOW_WRITE=true *and* a token.
 *
 * Errors never carry upstream detail: viem messages embed RPC URLs, which can contain API keys.
 */
export function startHttp(s: Services, host = s.ctx.config.httpHost ?? '127.0.0.1') {
  const config = s.ctx.config;
  const allowWrite = mcpWriteAllowed(config);
  const mcpEnabled = mcpHttpEnabled(config, host);
  if (config.mcpAllowWrite && !allowWrite) s.ctx.log('http', 'MCP write tools disabled over HTTP: set MCP_TOKEN (>= 16 chars)');
  if (!mcpEnabled) s.ctx.log('http', `/mcp disabled: HTTP_HOST ${host} is not loopback and MCP_TOKEN is unset`);
  let allowedHosts: string[] = [];

  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Bad request target' }); // an uncaught throw here would kill the agent
    }
    try {
      if (url.pathname === '/mcp') {
        if (req.method === 'OPTIONS') {
          res.writeHead(405).end(); // no CORS: browsers cannot be granted access to MCP
          return;
        }
        if (!mcpEnabled) return send(res, 403, { error: 'MCP over HTTP is off: set MCP_TOKEN (>= 16 characters) when HTTP_HOST is not loopback' }, false);
        // Browsers always send Origin; native MCP clients do not. No listed origin means no browser access at all.
        const origin = req.headers.origin;
        if (origin && !config.mcpAllowedOrigins.includes(origin)) return send(res, 403, { error: 'Origin not allowed' }, false);
        // DNS-rebinding protection before anything is read (the MCP transport checks again).
        if (!allowedHosts.includes(req.headers.host ?? '')) return send(res, 403, { error: 'Host not allowed' }, false);
        if (config.mcpToken && !bearerMatches(req.headers.authorization, config.mcpToken)) return send(res, 401, { error: 'Unauthorized' }, false);
        const body = req.method === 'POST' ? parseJson(await readBody(req, MCP_BODY_LIMIT)) : undefined;
        // Stateless mode: a fresh server/transport per request.
        const mcp = createMcpServer(s, { allowWrite });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: true,
          allowedHosts,
          allowedOrigins: config.mcpAllowedOrigins,
        });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'OPTIONS') return send(res, 204, '');

      if (url.pathname === '/oracle/update') {
        const symbols = parseSymbols(url.searchParams.get('symbols'));
        if (!symbols) return send(res, 400, { error: `symbols must be a comma-separated subset of ${PRICE_SYMBOLS.join(',')}` });
        try {
          return send(res, 200, await s.oracle.update(symbols));
        } catch (err) {
          return send(res, 502, { error: publicError(err) });
        }
      }
      if (url.pathname === '/oracle/health') {
        let status = s.watchdog.status();
        if (!status.report) {
          try {
            await s.watchdog.check();
          } catch (err) {
            return send(res, 503, { healthy: false, stale: true, error: publicError(err) });
          }
          status = s.watchdog.status();
        }
        const report = status.report!;
        return send(res, report.healthy && !status.stale ? 200 : 503, { ...report, stale: status.stale, ageSec: status.ageSec, error: status.error });
      }
      if (config.env === 'devnet' && url.pathname === '/oracle/admin/prices' && req.method === 'POST') {
        return send(res, 200, s.oracle.setMockPrices(parseJson(await readBody(req, ADMIN_BODY_LIMIT)) as Record<string, number>));
      }

      switch (url.pathname) {
        case '/health': {
          // 503 when a critical check fails (Docker healthcheck, monitoring); the body is the same either way.
          const report = s.monitor.report();
          return send(res, report.ok ? 200 : 503, report);
        }
        case '/status':
          // The /health body with 200 whenever the agent answers: for dashboards, and for load-balancer probes,
          // which must not pull the oracle relay out of rotation because the keeper needs attention.
          return send(res, 200, s.monitor.report());
        case '/metrics':
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(s.monitor.metrics());
          return;
        case '/revenue': {
          try {
            return send(res, 200, s.revenue.report() ?? (await s.revenue.refresh()));
          } catch (err) {
            return send(res, 503, { error: publicError(err) });
          }
        }
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
          const revenue = s.revenue.report();
          return send(res, 200, {
            borrowers: evals.length,
            debtUsd: debt,
            crossChainBorrowRatio: debt > 0 ? remoteBacked / debt : null,
            updatedAt: s.liquidator.lastRun,
            revenue: revenue
              ? { reservesUsd: revenue.totals.reservesUsd, treasuryCollateralUsd: revenue.totals.treasuryCollateralUsd, updatedAt: revenue.updatedAt }
              : null,
          });
        }
        case '/events': {
          // Owner and risk-parameter events on the hub and spokes, newest first (see watch.ts).
          const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
          return send(res, 200, { events: s.watch.recent().slice(0, limit), error: s.watch.lastError });
        }
        case '/messages': {
          const now = Date.now();
          const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
          const list = url.searchParams.get('pending') === '1' ? s.relayer.pending() : s.relayer.messages();
          return send(
            res,
            200,
            list.slice(0, limit).map(({ vaa: _vaa, ...m }) => ({ ...m, stuck: s.relayer.isStuck(m, now), ageSec: Math.round((now - m.observedAt) / 1000) })),
          );
        }
        case '/liquidatable':
          return send(
            res,
            200,
            s.liquidator.lastEvaluations
              .filter((e) => e.healthFactor < 1.2)
              .map((e) => ({ ...e, assessment: s.liquidator.lastAssessments.get(e.account.toLowerCase()) ?? null })),
          );
        default:
          return send(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      if (err instanceof HttpError) {
        const close = err.status === 413;
        res.writeHead(err.status, { 'content-type': 'application/json', ...CORS, ...(close ? { connection: 'close' } : {}) });
        res.end(toJson({ error: err.message }), () => {
          if (close) req.destroy();
        });
        return;
      }
      const error = publicError(err);
      s.ctx.log('http', 'request failed', { path: url.pathname, error });
      if (res.headersSent) return void res.end();
      return send(res, 500, { error });
    }
  });
  // Slow or never-ending requests must not pin connections: headers within 10 s, the whole request within 30 s.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  server.listen(config.httpPort, host, () => {
    const port = (server.address() as AddressInfo).port;
    allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...config.mcpAllowedHosts];
    s.ctx.log('http', 'listening', { host, port });
  });
  return server;
}
