// Drives the real web app against the local devnet with an injected dev wallet (anvil account #2).
// Prereqs: scripts/devnet/start.sh, the agent (relayer) and `VITE_MEZODOT_ENV=devnet pnpm dev`.
// Run: node scripts/e2e/ui-flows.mjs   (needs playwright-core and a Chrome at CHROME_PATH)
import { chromium } from 'playwright-core';

import { mkdirSync } from 'node:fs';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:3000/';
const ACCOUNT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const walletScript = `(() => {
  const RPC = { 31337: 'http://127.0.0.1:8545', 31338: 'http://127.0.0.1:8546' };
  const ACCOUNT = '${ACCOUNT}';
  let chainId = 31337;
  const listeners = {};
  const emit = (e, d) => (listeners[e] || []).forEach((f) => f(d));
  async function rpc(method, params) {
    const r = await fetch(RPC[chainId], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  }
  const provider = {
    request: async ({ method, params = [] }) => {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [ACCOUNT];
        case 'eth_chainId': return '0x' + chainId.toString(16);
        case 'net_version': return String(chainId);
        case 'wallet_switchEthereumChain': chainId = parseInt(params[0].chainId, 16); emit('chainChanged', '0x' + chainId.toString(16)); return null;
        case 'wallet_addEthereumChain': return null;
        case 'wallet_requestPermissions': case 'wallet_getPermissions': return [{ parentCapability: 'eth_accounts' }];
        default: return rpc(method, params);
      }
    },
    on: (e, f) => { (listeners[e] ||= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
  };
  window.ethereum = provider;
  const info = { uuid: '6f3c1c1e-0000-4000-8000-000000000001', name: 'Devnet Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=', rdns: 'dev.mezodot.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));
await page.addInitScript(walletScript);

const step = (name) => console.log(`\n› ${name}`);
const toast = async () => {
  const t = page.locator('.toast');
  await t.waitFor({ timeout: 60_000 });
  const text = await t.innerText();
  console.log('  toast:', text.replace(/\s+/g, ' '));
  await page
    .locator('.toast button')
    .click()
    .catch(() => {});
  return text;
};
const shot = (name) => page.screenshot({ path: `${OUT}ui-${name}.png`, fullPage: true });

step('load markets');
await page.goto(`${BASE}#/markets`);
await page.getByText('Markets & vaults').waitFor();
await page.locator('.market-detail-card').first().waitFor({ timeout: 30_000 });
console.log('  markets:', await page.locator('.market-detail-card b').first().innerText());

step('connect wallet');
await page.waitForTimeout(4000); // let wagmi finish its reconnect phase
if (!(await page.locator('.topbar-right').innerText()).includes('0x3C')) {
  await page.getByTestId('rk-connect-button').click();
  await page.getByText('Devnet Wallet').first().click({ timeout: 15_000 });
}
await page.waitForFunction(() => document.querySelector('.topbar-right')?.textContent?.includes('0x3C'), null, { timeout: 15_000 });
console.log('  connected');

step('flow A: supply 10,000 MUSD');
await page.locator('.market-detail-card').first().getByRole('button', { name: 'Supply', exact: true }).click();
await page.locator('#modal-amount').fill('10000');
await page.locator('form button[type=submit]').click();
console.log(' ', await toast());

step('post pMUSD as collateral (MAX)');
await page
  .locator('.market-detail-card')
  .first()
  .getByRole('button', { name: /Use as collateral/ })
  .click();
await page.locator('.amount-input button', { hasText: 'MAX' }).click();
await page.locator('form button[type=submit]').click();
await toast();
await shot('markets');

step('flow B: lock 1 WETH on the spoke');
await page.goto(`${BASE}#/crosschain`);
await page.locator('#bridge-amount').fill('1');
await page.getByRole('button', { name: /Lock on/ }).click();
await toast();
await page.locator('.flight').first().waitFor();
const t0 = Date.now();
await page.waitForFunction(() => document.querySelectorAll('.flight .message-step.step-done').length >= 4, null, { timeout: 90_000 });
console.log(`  delivered by agent relayer in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await shot('crosschain');

step('borrow 1,000 MUSD');
await page.goto(`${BASE}#/borrow`);
await page.locator('.collateral-detail').nth(1).waitFor({ timeout: 30_000 });
console.log('  collateral rows:', await page.locator('.collateral-detail').count());
await page.locator('#borrow-amount').fill('1000');
await page.getByRole('button', { name: /^Borrow MUSD/ }).click();
await toast();
console.log('  health:', await page.locator('.health-number strong').innerText());
await shot('borrow');

step('flow C: loop 1,000 MUSD at 3x');
await page.goto(`${BASE}#/loop`);
await page.getByRole('button', { name: /Open 3× loop/ }).click();
await toast();
await page.locator('.open-loop-panel').waitFor({ timeout: 30_000 });
console.log('  loop panel:', (await page.locator('.open-loop-panel .risk-math').innerText()).replace(/\s+/g, ' '));
await shot('loop');

step('dashboard + activity + agents');
await page.goto(`${BASE}#/`);
await page.waitForTimeout(4000);
console.log('  KPIs:', (await page.locator('.stats-grid').innerText()).replace(/\s+/g, ' ').slice(0, 260));
await shot('dashboard');
await page.goto(`${BASE}#/activity`);
await page.locator('.ledger-table tbody tr').first().waitFor({ timeout: 30_000 });
console.log('  activity rows:', await page.locator('.ledger-table tbody tr').count());
console.log('  kinds:', (await page.locator('.event-cell b').allInnerTexts()).join(', '));
await shot('activity');
await page.goto(`${BASE}#/agents`);
await page.waitForTimeout(3000);
await shot('agents');

const relevant = errors.filter((e) => !/walletconnect|WalletConnect|relay\.walletconnect|Reown|pulse\.walletconnect|lit/i.test(e));
console.log('\nERRORS:', relevant.length ? relevant : 'none', `(ignored ${errors.length - relevant.length} WalletConnect noise)`);
await browser.close();
