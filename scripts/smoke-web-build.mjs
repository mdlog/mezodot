// Loads the production build of the web app (apps/web/dist) in Chrome and fails on any page error or a page that
// renders nothing. A bundle can break in ways `vite dev` never shows: chunking changes the order modules evaluate in,
// and a module that throws while loading leaves the page blank.
// Run: VITE_ALLOW_LOCALHOST=true pnpm --filter @mezodot/web build && node scripts/smoke-web-build.mjs
// (needs playwright-core and a Chrome at CHROME_PATH)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(new URL('../apps/web/dist/', import.meta.url).pathname);
const ROUTES = ['#/', '#/dashboard', '#/portfolio'];
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// dist/ served the way a static host serves it.
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const file = resolve(DIST, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const failures = [];
for (const route of ROUTES) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + route, { waitUntil: 'load' });
  // The app renders into #root once every module has evaluated.
  const rendered = await page
    .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout: 15_000 })
    .then(
      () => true,
      () => false,
    );
  if (!rendered) failures.push(`${route}: nothing rendered`);
  for (const e of errors) failures.push(`${route}: ${e}`);
  await page.close();
}
await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`The production build does not load:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`The production build loads: ${ROUTES.join(', ')} render without page errors.`);
