// Drives the real web app against the local devnet with an injected dev wallet (anvil account #2).
// Prereqs: scripts/devnet/start.sh, the agent (relayer) and `VITE_MEZODOT_ENV=devnet pnpm dev`.
// Run: node scripts/e2e/ui-flows.mjs   (needs playwright-core and a Chrome at CHROME_PATH)
// Covers the PRD flows (A supply, B cross-chain lock, C loop) and the exits: withdraw, remove collateral,
// repay (from the wallet and with posted pMUSD), unwind, release to the spoke, and BTC collateral + BTC
// leverage when the devnet deploys them.
// Any transaction that ends in an error toast fails the run.
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
// "Failed to load resource" console lines carry no URL; failed responses are recorded with theirs below.
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text().slice(0, 200)}`));
page.on('response', (r) => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 160)}`));
await page.addInitScript(walletScript);

const step = (name) => console.log(`\n› ${name}`);
const shot = (name) => page.screenshot({ path: `${OUT}ui-${name}.png`, fullPage: true });

/** Waits for the action's result toast (not the progress panel), dismisses it, and fails the run on an error. */
const result = async (timeout = 90_000) => {
  const t = page.locator('.toast--ok, .toast--error').first();
  await t.waitFor({ timeout });
  const ok = await t.evaluate((el) => el.classList.contains('toast--ok'));
  const text = (await t.innerText()).replace(/\s+/g, ' ');
  console.log(`  ${ok ? 'ok' : 'FAILED'}:`, text);
  await t
    .getByRole('button', { name: 'Dismiss notification' })
    .click()
    .catch(() => {});
  if (!ok) throw new Error(`transaction failed: ${text}`);
  return text;
};

/** Fills the open action dialog and submits it. */
const submitModal = async (input, amount) => {
  await page.locator(input).fill(amount);
  await page.locator('form button[type=submit]').click();
  await result();
};

const card = (text) => page.locator('.market-detail-card', { hasText: text }).first();

step('load markets');
await page.goto(`${BASE}#/markets`);
await page.getByText('Markets & vaults').waitFor();
await page.locator('.market-detail-card').first().waitFor({ timeout: 30_000 });
console.log('  markets:', await page.locator('.market-detail-card b').first().innerText());
if ((await page.locator('.status-banner--error').count()) > 0) throw new Error(`hub unreadable: ${await page.locator('.status-banner--error').innerText()}`);

step('connect wallet');
await page.waitForTimeout(4000); // let wagmi finish its reconnect phase
if (!(await page.locator('.topbar-right').innerText()).includes('0x3C')) {
  await page.getByTestId('rk-connect-button').click();
  await page.getByText('Devnet Wallet').first().click({ timeout: 15_000 });
}
await page.waitForFunction(() => document.querySelector('.topbar-right')?.textContent?.includes('0x3C'), null, { timeout: 15_000 });
console.log('  connected');

step('flow A: supply 10,000 MUSD');
await card('MUSD').getByRole('button', { name: 'Supply', exact: true }).click();
await submitModal('#modal-amount', '10000');

step('exit: withdraw 100 MUSD of the supply');
await card('MUSD').getByRole('button', { name: 'Withdraw', exact: true }).click();
await submitModal('#modal-amount', '100');

step('post pMUSD as collateral (MAX)');
await card('MUSD')
  .getByRole('button', { name: /Use as collateral/ })
  .click();
await page.locator('.amount-input button', { hasText: 'MAX' }).click();
await page.locator('form button[type=submit]').click();
await result();
await shot('markets');

step('flow B: lock 1 WETH on the spoke');
await page.goto(`${BASE}#/crosschain`);
await page.locator('#bridge-amount').fill('1');
await page.getByRole('button', { name: /Lock on/ }).click();
await result();
await page.locator('.flight').first().waitFor();
let t0 = Date.now();
await page.waitForFunction(() => document.querySelector('.flight')?.querySelectorAll('.message-step.step-done').length >= 4, null, { timeout: 90_000 });
console.log(`  delivered by agent relayer in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await shot('crosschain');

step('borrow 1,000 MUSD');
await page.goto(`${BASE}#/borrow`);
await page.locator('.collateral-detail').nth(1).waitFor({ timeout: 30_000 });
console.log('  collateral rows:', await page.locator('.collateral-detail').count());
await page.locator('#borrow-amount').fill('1000');
await page.getByRole('button', { name: /^Borrow MUSD/ }).click();
await result();
console.log('  health:', await page.locator('.health-number strong').innerText());
await shot('borrow');

step('exit: repay 100 MUSD');
await page.getByRole('button', { name: 'Repay', exact: true }).click();
await submitModal('#modal-amount', '100');

step('exit: remove 10 MUSD of pMUSD collateral (needs fresh prices for the health check)');
await page.goto(`${BASE}#/markets`);
await card('MUSD').getByRole('button', { name: 'Remove', exact: true }).click();
await submitModal('#modal-amount', '10');

step('exit: repay the rest of the MUSD debt with posted pMUSD (VaultManager.repayWithCollateral, no MUSD needed)');
await page.goto(`${BASE}#/borrow`);
const repayWithShares = page.getByRole('button', { name: /with posted pMUSD/ });
await repayWithShares.waitFor({ timeout: 30_000 });
console.log('  ', (await repayWithShares.innerText()).replace(/\s+/g, ' '));
await repayWithShares.click();
await result();

// Loop count before flow C, so the dashboard check below waits for this run's loop specifically.
const LOOPS = /(\d+) MUSD loops?/;
const loopsKpi = async () => Number(((await page.getByText(LOOPS).innerText()).match(LOOPS) ?? [])[1] ?? NaN);
await page.goto(`${BASE}#/dashboard`);
await page.getByText(LOOPS).waitFor({ timeout: 45_000 });
await page.waitForTimeout(2000);
const loopsBefore = await loopsKpi();

step('flow C: loop 1,000 MUSD at 3x');
await page.goto(`${BASE}#/loop`);
// The desk opens on BTC leverage when it is deployed.
await page.getByRole('tab', { name: /MUSD loop/ }).click();
await page.locator('#loop-amount').fill('1000');
await page.getByRole('button', { name: /Open 3× loop/ }).click();
await result();
await page.locator('.open-loop-panel').waitFor({ timeout: 30_000 });
console.log('  loop panel:', (await page.locator('.open-loop-panel .risk-math').innerText()).replace(/\s+/g, ' '));
await shot('loop');

step('dashboard + activity + agents');
await page.goto(`${BASE}#/dashboard`);
// Event-derived KPIs refresh on their own interval: wait until the loop above shows up.
await page.getByText(new RegExp(`${loopsBefore + 1} MUSD loops?`)).waitFor({ timeout: 60_000 });
console.log('  KPIs:', (await page.locator('.stats-grid').innerText()).replace(/\s+/g, ' ').slice(0, 260));
await shot('dashboard');
await page.goto(`${BASE}#/activity`);
await page.locator('.event-cell b', { hasText: 'Loop' }).first().waitFor({ timeout: 45_000 });
console.log('  activity rows:', await page.locator('.ledger-table tbody tr').count());
console.log('  kinds:', (await page.locator('.event-cell b').allInnerTexts()).join(', '));
await shot('activity');
await page.goto(`${BASE}#/agents`);
await page.waitForTimeout(3000);
await shot('agents');

step('exit: unwind the loop');
await page.goto(`${BASE}#/loop`);
await page.getByRole('tab', { name: /MUSD loop/ }).click();
await page.locator('.open-loop-panel').waitFor({ timeout: 30_000 });
await page
  .locator('.open-loop-panel')
  .getByRole('button', { name: /Unwind/ })
  .click();
await result();
await page.locator('.open-loop-panel').waitFor({ state: 'detached', timeout: 30_000 });
console.log('  loop closed');

step('exit: release 0.5 WETH back to the spoke');
await page.goto(`${BASE}#/crosschain`);
await page.locator('#withdraw-remote').fill('0.5');
await page.getByRole('button', { name: 'Release on spoke' }).click();
await result();
await page.locator('.flight', { hasText: 'back to' }).first().waitFor();
t0 = Date.now();
await page.waitForFunction(
  () => [...document.querySelectorAll('.flight')].find((f) => f.textContent?.includes('back to'))?.querySelectorAll('.message-step.step-done').length >= 4,
  null,
  { timeout: 90_000 },
);
console.log(`  released on the spoke in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await shot('release');

step('BTC collateral and BTC leverage');
await page.goto(`${BASE}#/markets`);
await page.locator('.market-detail-card').first().waitFor({ timeout: 30_000 });
if ((await page.locator('.market-detail-card', { hasText: 'BTC collateral' }).count()) === 0) {
  console.log('  skipped: this devnet has no BTC collateral');
} else {
  await card('BTC collateral').getByRole('button', { name: 'Post BTC' }).click();
  await submitModal('#token-collateral-amount', '0.01');
  await card('BTC collateral').getByRole('button', { name: 'Remove', exact: true }).click();
  await submitModal('#token-collateral-amount', '0.002');

  await page.goto(`${BASE}#/loop`);
  await page.getByRole('tab', { name: /BTC leverage/ }).click();
  if ((await page.locator('#btc-amount').count()) === 0) {
    console.log('  BTC leverage skipped: SwapLeverageManager is not deployed on this devnet');
  } else {
    await page.locator('#btc-amount').fill('0.005');
    const open = page.getByRole('button', { name: /Open 2× BTC/ });
    await page.waitForFunction(() => !document.body.textContent?.includes('Fetching a Tigris quote'), null, { timeout: 30_000 });
    await open.click();
    await result();
    const panel = page.locator('.open-loop-panel', { hasText: 'Open BTC position' });
    await panel.waitFor({ timeout: 30_000 });
    console.log('  BTC position:', (await panel.locator('.risk-math').innerText()).replace(/\s+/g, ' '));
    await shot('btc-leverage');
    const close = panel.getByRole('button', { name: /^Close/ });
    await page.waitForFunction(() => ![...document.querySelectorAll('.open-loop-panel button')].some((b) => b.textContent?.includes('Quoting')), null, {
      timeout: 30_000,
    });
    await close.click();
    await result();
    await panel.waitFor({ state: 'detached', timeout: 30_000 });
    console.log('  BTC position closed');
  }
}

const relevant = errors.filter((e) => !/walletconnect|WalletConnect|relay\.walletconnect|Reown|pulse\.walletconnect|web3modal|lit/i.test(e));
console.log('\nERRORS:', relevant.length ? relevant : 'none', `(ignored ${errors.length - relevant.length} WalletConnect noise)`);
await browser.close();
