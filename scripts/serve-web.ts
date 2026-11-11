// Serves the production build of the web app (apps/web/dist) the way it should be hosted: GET and HEAD only, no
// dotfiles or paths outside the build, hashed assets cached for a year, index.html revalidated on every visit, and the
// security headers a dev server never sends. The app routes with the URL hash, so there is no SPA fallback.
//
// Run: pnpm --filter @mezodot/web build && node scripts/serve-web.ts
//   WEB_HOST (127.0.0.1), WEB_PORT (3000), WEB_ROOT (apps/web/dist)
//   WEB_ALLOWED_HOSTS  Host names answered besides loopback, comma-separated (the public hostname); unset answers any
// Node 22 runs this file as is (type stripping): keep it to erasable TypeScript and node: imports.
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/**
 * Sent with every response. The CSP restricts only framing, plugins and <base>: the wallet libraries load scripts and
 * reach RPCs that a stricter policy would have to list and keep in step.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  // Ignored over plain HTTP; behind the HTTPS tunnel it keeps visitors on HTTPS. No includeSubDomains: that would
  // bind every other host under the domain.
  'strict-transport-security': 'max-age=31536000',
};

const IMMUTABLE = 'public, max-age=31536000, immutable'; // Vite puts a content hash in every /assets/ file name

/** A Host header's name without the port, lowercased: "[::1]:3000" → "::1". */
const hostName = (host: string) =>
  host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[(.*)\]$/, '$1');
const isLoopbackName = (name: string) => name === 'localhost' || name === '::1' || /^127\./.test(name);

export type WebServerOptions = {
  /** The build to serve (apps/web/dist). */
  root: string;
  /** Host names answered besides loopback; empty answers any. */
  allowedHosts: string[];
};

export function createWebServer({ root: rootDir, allowedHosts }: WebServerOptions) {
  const root = resolve(rootDir);
  if (!existsSync(resolve(root, 'index.html'))) throw new Error(`no index.html in ${root}: build the web app first (pnpm --filter @mezodot/web build)`);
  const hosts = allowedHosts.map((h) => h.toLowerCase());
  const hostAllowed = (host: string | undefined) =>
    hosts.length === 0 || (host !== undefined && (isLoopbackName(hostName(host)) || hosts.includes(hostName(host)) || hosts.includes(host.toLowerCase())));

  const reply = (res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...headers });
    res.end(`${text}\n`);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!hostAllowed(req.headers.host)) return reply(res, 421, 'Misdirected request');
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return reply(res, 400, 'Bad request');
    }
    if (path.includes('\0')) return reply(res, 400, 'Bad request');
    const segments = path.split('/').filter(Boolean);
    // No dotfiles (.env, .git) and no `..`; whatever is left must still resolve inside the root.
    if (segments.some((s) => s.startsWith('.'))) return reply(res, 404, 'Not found');
    const file = resolve(root, ...(segments.length > 0 ? segments : ['index.html']));
    if (!file.startsWith(root + sep)) return reply(res, 404, 'Not found');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return reply(res, 404, 'Not found');

    const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    const headers = {
      ...SECURITY_HEADERS,
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': segments[0] === 'assets' ? IMMUTABLE : 'no-cache',
      etag,
      'last-modified': info.mtime.toUTCString(),
    };
    const known = (req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim());
    if (known.includes(etag)) {
      res.writeHead(304, headers);
      return void res.end();
    }
    res.writeHead(200, { ...headers, 'content-length': String(info.size) });
    if (req.method === 'HEAD') return void res.end();
    await pipeline(createReadStream(file), res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (err.message) console.error(`serve-web: ${req.url}: ${err.message}`);
      if (!res.headersSent) reply(res, 500, 'Internal error');
      else res.destroy();
    });
  });
  // Slow or never-ending requests must not pin connections.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.WEB_HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.WEB_PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`WEB_PORT must be a port number (got ${process.env.WEB_PORT})`);
  const root = process.env.WEB_ROOT?.trim() || fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
  const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const server = createWebServer({ root, allowedHosts });
  server.listen(port, host, () => {
    const scope = allowedHosts.length > 0 ? `for ${allowedHosts.join(', ')} and loopback` : 'for any Host';
    console.log(`serve-web: ${root} on http://${host}:${port}, ${scope}`);
  });
  // Requests in flight get a moment to finish; idle keep-alive connections (the tunnel holds some) are closed now.
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
