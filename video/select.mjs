// Collects, live, every fact the narration states into out/take.json, and refuses a take that would not be true:
// failing contract tests, a failing deployment check, a contract unverified on Mezo's explorer or not exactly matched
// on Sourcify, the agent or the web app down, or an oracle leg the agent cannot name. Also captures the explorer page
// shown in the proof beat (off camera).
//
//   node video/select.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { AGENT, APP, CHROME, OUT } from './config.mjs';
import { CONTRACTS, check as sourcify } from './sourcify.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    code: r.status,
    lines: stripAnsi(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)
      .split('\n')
      .map((l) => l.trim()),
  };
};
const refuse = (why) => {
  console.error(`refusing the take: ${why}`);
  process.exit(1);
};

mkdirSync(`${OUT}shots`, { recursive: true });

console.log('› forge test');
const forge = run('forge', ['test', '--root', 'contracts']);
const forgeLine = forge.lines.find((l) => /^Ran \d+ test suites/.test(l));
const fm = forgeLine?.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped/);
if (forge.code !== 0 || !fm || fm[2] !== '0') refuse(`contract tests: ${forgeLine ?? 'no summary line'}`);

console.log('› pnpm verify:deployment mezo-testnet');
const dep = run('bash', ['-c', 'set -a; source contracts/.env.example; set +a; pnpm verify:deployment mezo-testnet']);
const depLine = dep.lines.find((l) => /^\d+ passed, \d+ failed, \d+ warnings?, \d+ notes?$/.test(l));
const dm = depLine?.match(/^(\d+) passed, (\d+) failed/);
if (dep.code !== 0 || !dm || dm[2] !== '0') refuse(`deployment check: ${depLine ?? 'no summary line'}`);

console.log('› sourcify');
const src = await sourcify();
if (src.exact !== src.total) refuse(`Sourcify: ${src.exact}/${src.total} exact matches`);

console.log('› agent and web app');
const status = await (await fetch(`${AGENT}/status`)).json();
if (status.status !== 'ok') refuse(`agent status ${status.status}`);
if (!(await fetch(APP)).ok) refuse('web app not reachable');

console.log('› oracle legs');
const ORACLE = `curl -s ${AGENT}/oracle/health | jq -r '.feeds[] | "\\(.symbol)\\t\\(.status)\\t\\(.sources | join(", "))"'`;
const oracle = run('bash', ['-c', ORACLE]).lines.filter(Boolean);
if (oracle.length !== 5) refuse(`oracle health: ${oracle.length} feeds`);
if (oracle.some((l) => /source\d/.test(l))) refuse('the agent cannot name a leg: restart it on the current code');
if (!/^BTC\s+ok\s+skip/.test(oracle.find((l) => l.startsWith('BTC')) ?? '')) refuse('BTC is not reading Skip');
if (!/^MUSD\s+ok\s+pyth.*twap/.test(oracle.find((l) => l.startsWith('MUSD')) ?? '')) refuse('MUSD has no TWAP leg');

console.log('› protocol rates');
const call = (to, sig) => {
  const r = run('cast', ['call', to, sig, '--rpc-url', 'https://rpc.test.mezo.org']);
  if (r.code !== 0) refuse(`${sig}: ${r.lines.join(' ')}`);
  return BigInt(r.lines[0].split(' ')[0]);
};
const hubJson = JSON.parse(readFileSync(`${ROOT}packages/sdk/src/deployments/mezo-testnet.json`, 'utf8'));
const { pMUSD, vaultManager } = hubJson.contracts;
const revenue = {
  reserveFactorPct: Number(call(pMUSD, 'reserveFactor()(uint256)') / 10n ** 16n),
  flashFeePct: Number(call(pMUSD, 'FLASH_FEE_BPS()(uint256)')) / 100,
  liquidationFeePct: Number(call(vaultManager, 'liquidationFeeBps()(uint256)')) / 100,
};

console.log("› Mezo's explorer");
const hubContracts = CONTRACTS.filter(([id]) => id === 31611);
let verified = 0;
for (const [, name, address] of hubContracts) {
  const c = await (await fetch(`https://api.explorer.test.mezo.org/api/v2/smart-contracts/${address}`)).json();
  if (c.is_verified) verified++;
  else console.log(`  not verified: ${name}`);
}
if (verified !== hubContracts.length) refuse(`explorer: ${verified}/${hubContracts.length} hub contracts verified`);
const vault = hubContracts.find(([, name]) => name === 'VaultManager');
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
await page.goto(`https://explorer.test.mezo.org/address/${vault[2]}?tab=contract`, { waitUntil: 'load', timeout: 60_000 });
await page
  .getByText(/verified/i)
  .first()
  .waitFor({ timeout: 45_000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}shots/explorer.png` });
await browser.close();

const take = {
  at: new Date().toISOString(),
  contracts: { passed: Number(fm[1]), failed: Number(fm[2]), skipped: Number(fm[3]), line: forgeLine },
  deployment: { passed: Number(dm[1]), failed: Number(dm[2]), line: depLine },
  sourcify: { exact: src.exact, total: src.total, lines: src.lines },
  explorer: { verified, total: hubContracts.length },
  agent: { status: status.status, modules: status.modules },
  revenue,
  terminal: [
    { cmd: ORACLE, out: oracle },
    { cmd: 'forge test --root contracts', out: [forgeLine] },
    { cmd: 'pnpm verify:deployment mezo-testnet', out: [depLine] },
  ],
  shots: { explorer: `${OUT}shots/explorer.png` },
};
writeFileSync(`${OUT}take.json`, JSON.stringify(take, null, 2));
console.log(
  `take.json: ${take.contracts.passed} contract tests, ${take.deployment.passed} deployment checks, ${src.exact}/${src.total} Sourcify, ${verified}/${hubContracts.length} explorer`,
);
