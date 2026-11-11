import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebServer } from '../serve-web';

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

let dir = '';
let root = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'serve-web-'));
  root = join(dir, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(root, 'assets', 'app-1a2b3c.js'), 'console.log(1);');
  writeFileSync(join(root, 'assets', '.hidden'), 'hidden');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'secret.txt'), 'outside the root');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function serve(allowedHosts: string[] = []) {
  const server = createWebServer({ root, allowedHosts });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return { server, port: (server.address() as AddressInfo).port };
}

const call = (port: number, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    // agent: false: a connection per request, so closing the server never waits on a pooled keep-alive socket.
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

/** Sends a request line as is (no client-side normalisation), resolving with the status code. */
const rawStatus = (port: number, target: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = '';
    socket.on('data', (c) => (data += c.toString()));
    socket.on('end', () => resolve(Number(data.split(' ')[1])));
    socket.on('error', reject);
  });

const close = (server: Server) => new Promise((done) => server.close(done));

describe('static server for the web build (scripts/serve-web.ts)', () => {
  it('serves index.html at / with the security headers, revalidated on every visit', async () => {
    const { server, port } = await serve();
    try {
      const res = await call(port, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<div id="root">');
      expect(res.headers).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      });
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['strict-transport-security']).toMatch(/^max-age=\d+$/);
      expect((await call(port, '/index.html')).status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it('serves hashed assets as immutable, with their content type', async () => {
    const { server, port } = await serve();
    try {
      const js = await call(port, '/assets/app-1a2b3c.js');
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect((await call(port, '/favicon.svg')).headers['content-type']).toBe('image/svg+xml');
    } finally {
      await close(server);
    }
  });

  it('answers HEAD without a body, revalidates with ETag, and refuses other methods', async () => {
    const { server, port } = await serve();
    try {
      const head = await call(port, '/', { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
      const etag = String(head.headers.etag);
      const again = await call(port, '/', { headers: { 'if-none-match': etag } });
      expect(again.status).toBe(304);
      expect(again.body).toBe('');
      const post = await call(port, '/', { method: 'POST' });
      expect(post.status).toBe(405);
      expect(post.headers.allow).toBe('GET, HEAD');
      expect(post.headers['x-frame-options']).toBe('DENY');
    } finally {
      await close(server);
    }
  });

  it('never serves dotfiles, directories or anything outside the root', async () => {
    const { server, port } = await serve();
    try {
      for (const path of ['/.env', '/assets/.hidden', '/%2eenv', '/assets/', '/assets', '/..%2fsecret.txt', '/%2e%2e/secret.txt']) {
        expect([path, (await call(port, path)).status]).toEqual([path, 404]);
      }
      expect(await rawStatus(port, '/../secret.txt')).toBe(404);
      expect(await rawStatus(port, '/assets/../../secret.txt')).toBe(404);
    } finally {
      await close(server);
    }
  });

  it('answers a malformed path with 400 and keeps serving', async () => {
    const { server, port } = await serve();
    try {
      expect((await call(port, '/%E0%A4%A')).status).toBe(400);
      expect((await call(port, '/a%00b')).status).toBe(400);
      expect((await call(port, '/')).status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it('has no SPA fallback: the app routes with the URL hash, so unknown paths are 404', async () => {
    const { server, port } = await serve();
    try {
      const res = await call(port, '/dashboard');
      expect(res.status).toBe(404);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await close(server);
    }
  });

  it('answers only the listed hosts and loopback once WEB_ALLOWED_HOSTS is set', async () => {
    const { server, port } = await serve(['app.example.org']);
    try {
      expect((await call(port, '/', { headers: { host: 'other.example' } })).status).toBe(421);
      expect((await call(port, '/', { headers: { host: 'App.Example.org' } })).status).toBe(200);
      expect((await call(port, '/', { headers: { host: `localhost:${port}` } })).status).toBe(200);
      expect((await call(port, '/', { headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
    } finally {
      await close(server);
    }
    const open = await serve();
    try {
      expect((await call(open.port, '/', { headers: { host: 'other.example' } })).status).toBe(200);
    } finally {
      await close(open.server);
    }
  });

  it('refuses to start without a build', () => {
    expect(() => createWebServer({ root: join(dir, 'missing'), allowedHosts: [] })).toThrow(/no index\.html .*build the web app first/);
  });
});
