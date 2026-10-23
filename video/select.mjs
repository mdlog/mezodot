// Collects, live, every fact the narration states into out/take.json, and refuses a take that would not be true:
// failing contract tests, a failing deployment check, a contract not exactly matched on Sourcify, the agent or the
// web app down. Also captures the Sourcify page shown in the proof beat (off camera).
//
//   node video/select.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const dep = run('pnpm', ['verify:deployment', 'mezo-testnet']);
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

console.log('› Sourcify page capture');
const vault = CONTRACTS.find(([, name]) => name === 'VaultManager');
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
await page.goto(`https://repo.sourcify.dev/${vault[0]}/${vault[2]}`, { waitUntil: 'load', timeout: 60_000 });
await page.getByText('Exact Match').first().waitFor({ timeout: 30_000 });
await page.getByText('Creation Bytecode').first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
if (await page.getByText('only matched with runtime bytecode').count()) refuse('Sourcify shows a runtime-only match for VaultManager');
await page.screenshot({ path: `${OUT}shots/sourcify.png` });
await browser.close();

const take = {
  at: new Date().toISOString(),
  contracts: { passed: Number(fm[1]), failed: Number(fm[2]), skipped: Number(fm[3]), line: forgeLine },
  deployment: { passed: Number(dm[1]), failed: Number(dm[2]), line: depLine },
  sourcify: { exact: src.exact, total: src.total, lines: src.lines },
  agent: { status: status.status, modules: status.modules },
  terminal: [
    { cmd: 'forge test --root contracts', out: [forgeLine] },
    { cmd: 'pnpm verify:deployment mezo-testnet', out: [depLine] },
    { cmd: 'node video/sourcify.mjs', out: src.lines },
  ],
  shots: { sourcify: `${OUT}shots/sourcify.png` },
};
writeFileSync(`${OUT}take.json`, JSON.stringify(take, null, 2));
console.log(`take.json: ${take.contracts.passed} contract tests, ${take.deployment.passed} deployment checks, ${src.exact}/${src.total} Sourcify`);
