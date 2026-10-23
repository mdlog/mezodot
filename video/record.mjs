// Films every beat as timestamped JPEG frames from Chrome's screencast (sharper than Playwright's 1 Mbit/s VP8). A clip
// starts once its page is ready (t0); every action fires when the narration reaches its anchor phrase; the clip holds
// max(narration + tail, minMs), and a transaction beat also holds until its confirmation toast has been on screen.
// Writes out/timeline.json for build.py: each clip's frames, t0, length and the transactions it sent.
//
//   node video/record.mjs --connect    connect the demo wallet once (off camera) and keep the session for the beats
//   node video/record.mjs --probe      every page loads, every selector and anchor resolves; sends no transaction
//   node video/record.mjs [beat ...]   film every beat, or only the named ones

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { beats } from './beats.mjs';
import { APP, CHROME, OUT } from './config.mjs';
import { APP_INIT, lowerThird, outroPage, terminalPage } from './scenes.mjs';
import { demoAccount, exposeSigner, publicClient, walletInit } from './wallet.mjs';

const TAIL_MS = 400;
/** A transaction beat keeps its confirmation toast on screen at least this long. */
const AFTER_TOAST_MS = 1800;
const VIEW = { width: 1920, height: 1080 };
const STATE = `${OUT}wallet-state.json`;
/** Never film these: a crashed view, simulated data, or a failed load. */
const REFUSE = ['unexpected error', 'SIMULATED', 'could not load', 'Something went wrong'];

const args = process.argv.slice(2);
const probe = args.includes('--probe');
const only = args.filter((a) => !a.startsWith('--'));
const take = JSON.parse(readFileSync(`${OUT}take.json`, 'utf8'));
const list = beats(take).filter((b) => only.length === 0 || only.includes(b.id));
const account = demoAccount();
/** Every transaction the demo wallet sends from a recorded page. */
const txLog = [];

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Milliseconds into the narration where `phrase` starts. */
function anchor(tokens, phrase) {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  const have = tokens.map((t) => norm(t.w));
  for (let i = 0; i + want.length <= have.length; i++) if (want.every((w, k) => have[i + k] === w)) return tokens[i].s * 1000;
  throw new Error(`anchor "${phrase}" is not in the narration`);
}

/** On-screen actions with a visible, eased cursor. */
function helpers(page) {
  let pos = { x: 1180, y: 620 };
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  async function moveTo(x, y, ms = 480) {
    const from = { ...pos };
    const steps = Math.round(ms / 16);
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      await page.waitForTimeout(ms / steps);
    }
    pos = { x, y };
  }
  /** The element's centre, scrolled smoothly into the band the captions leave free. */
  async function locate(sel) {
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    let box = await loc.boundingBox();
    if (box.y < 80 || box.y + box.height > VIEW.height - 170) {
      await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await page.waitForTimeout(750);
      box = await loc.boundingBox();
    }
    return { loc, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  return {
    park: () => page.mouse.move(pos.x, pos.y),
    async hover(sel) {
      const t = await locate(sel);
      await moveTo(t.x, t.y);
    },
    /** Clicks once the control is enabled (a live quote can keep a button disabled for a moment). */
    async click(sel) {
      const t = await locate(sel);
      await moveTo(t.x, t.y);
      for (let i = 0; i < 40 && !(await t.loc.isEnabled()); i++) await page.waitForTimeout(250);
      await page.mouse.click(t.x, t.y);
    },
    async fill(sel, text) {
      const t = await locate(sel);
      await moveTo(t.x, t.y);
      await page.mouse.click(t.x, t.y, { clickCount: 3 });
      await page.keyboard.type(text, { delay: 120 });
    },
    press: (key) => page.keyboard.press(key),
    scrollTo: (sel) =>
      page
        .locator(sel)
        .first()
        .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' })),
    reveal: (n) => page.evaluate((k) => window.reveal(k), n),
    showShot: () => page.evaluate(() => window.showShot()),
  };
}

/** Loads an app route and waits for its live reads; reloads once if the ready marker never shows. */
async function openApp(page, b) {
  await page.goto(APP + b.route, { waitUntil: 'load' });
  try {
    await page.locator(b.ready).first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    await page.reload({ waitUntil: 'load' });
    await page.locator(b.ready).first().waitFor({ state: 'visible', timeout: 15_000 });
  }
  await page.waitForTimeout(3000);
}

/** A context whose pages see the demo wallet (EIP-1193 + EIP-6963) and send through this process. */
async function walletContext(browser, stored) {
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, ...(stored && existsSync(STATE) ? { storageState: STATE } : {}) });
  await ctx.addInitScript(walletInit(account.address));
  await exposeSigner(ctx, account, txLog);
  return ctx;
}

const connected = (page) =>
  page
    .locator('.topbar-right')
    .innerText()
    .then((t) => t.includes(account.address.slice(-4)));

/** Connects through the app's own wallet dialog unless the stored session already reconnected. */
async function ensureConnected(page) {
  for (let i = 0; i < 16 && !(await connected(page)); i++) await page.waitForTimeout(500);
  if (await connected(page)) return;
  await page.getByTestId('rk-connect-button').click();
  await page.getByText('Demo Wallet').first().click({ timeout: 15_000 });
  await page.waitForFunction((tail) => document.querySelector('.topbar-right')?.textContent?.includes(tail), account.address.slice(-4), {
    timeout: 20_000,
  });
}

async function connectWallet(browser) {
  const ctx = await walletContext(browser, false);
  await ctx.addInitScript(APP_INIT);
  const page = await ctx.newPage();
  await openApp(page, { route: '#/markets', ready: 'text=Markets & vaults' });
  await ensureConnected(page);
  await ctx.storageState({ path: STATE });
  await ctx.close();
  console.log(`connected ${account.address}; session saved to ${STATE}`);
}

/** Records the page's screencast into dir: one JPEG per frame plus frames.json with each frame's epoch time (s). */
async function screencast(page, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const name = `${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(`${dir}/${name}`, Buffer.from(data, 'base64'));
    frames.push({ name, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
    return frames.length;
  };
}

/** Waits for the action's result toast; a failed transaction refuses the take. Returns when it appeared. */
async function confirmation(page, timeout) {
  const t = page.locator('.toast--ok, .toast--error').first();
  await t.waitFor({ timeout });
  const text = (await t.innerText()).replace(/\s+/g, ' ');
  if (await t.evaluate((el) => el.classList.contains('toast--error'))) throw new Error(`transaction failed on camera: ${text}`);
  return { at: Date.now(), text };
}

async function film(browser, b) {
  if (b.before && !probe) await b.before({ browser, walletContext, openApp, ensureConnected, APP_INIT });
  const words = JSON.parse(readFileSync(`${OUT}tts/${b.id}.json`, 'utf8'));
  let durMs = Math.round(Math.max(words.duration * 1000 + (b.tailMs ?? TAIL_MS), b.minMs));
  const dir = `${OUT}clips/${b.id}`;
  const ctx = b.wallet ? await walletContext(browser, true) : await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  if (b.route) await ctx.addInitScript(APP_INIT);
  const page = await ctx.newPage();
  const stop = probe ? null : await screencast(page, dir);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  if (b.route) await openApp(page, b);
  else if (b.terminal) {
    await page.setContent(terminalPage(take, take.shots.sourcify), { waitUntil: 'load' });
    // Decode the Sourcify capture now, or its first frames on screen are blank.
    await page.evaluate(() => document.querySelector('#shot img').decode());
  } else if (b.card === 'outro') await page.setContent(outroPage(), { waitUntil: 'load' });
  if (b.wallet) await ensureConnected(page);
  if (b.ready2) await page.locator(b.ready2).first().waitFor({ state: 'visible', timeout: 90_000 });
  const h = helpers(page);
  if (b.route) await h.park();
  const text = await page.evaluate(() => document.body.innerText);
  const bad = REFUSE.find((s) => text.includes(s));
  if (bad) throw new Error(`${b.id}: "${bad}" is on screen`);

  const sentBefore = txLog.length;
  const t0 = Date.now();
  if (b.lowerThird) await page.evaluate(lowerThird(b.lowerThird));
  for (const a of b.actions) {
    if (probe && a.send) continue; // a probe never sends a transaction
    const at = anchor(words.tokens, a.at) + (a.offsetMs ?? 0);
    if (!probe) {
      const wait = t0 + at - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const late = Date.now() - (t0 + at);
      if (late > 700) console.warn(`  ${b.id}: "${a.at}" started ${late} ms late`);
    }
    try {
      await a.do(h);
    } catch (e) {
      throw new Error(`${b.id} @ "${a.at}": ${e.message.split('\n')[0]}`);
    }
  }
  let toast = null;
  if (b.awaitToast && !probe) {
    toast = await confirmation(page, 90_000);
    durMs = Math.max(durMs, toast.at - t0 + AFTER_TOAST_MS);
    console.log(`  ${b.id}: "${toast.text.slice(0, 80)}" ${((toast.at - t0) / 1000).toFixed(1)} s in`);
  }
  if (!probe) {
    const rest = t0 + durMs - Date.now();
    if (rest > 0) await page.waitForTimeout(rest);
  }
  if (errors.length) throw new Error(`${b.id}: page errors ${JSON.stringify(errors)}`);
  const frames = probe ? 0 : await stop();
  await ctx.close();
  if (probe) return null;
  if (frames < 1) throw new Error(`${b.id}: no frames captured`);
  const txs = [];
  for (const tx of txLog.slice(sentBefore)) {
    const receipt = await publicClient(tx.chainId).waitForTransactionReceipt({ hash: tx.hash });
    if (receipt.status !== 'success') throw new Error(`${b.id}: transaction ${tx.hash} reverted`);
    txs.push({ chainId: tx.chainId, hash: tx.hash, block: Number(receipt.blockNumber) });
  }
  return { id: b.id, dir, t0: t0 / 1000, durMs, frames, chip: b.chip, chapter: b.chapter, txs, toast: toast?.text ?? null };
}

mkdirSync(`${OUT}clips`, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const timelinePath = `${OUT}timeline.json`;
const timeline = existsSync(timelinePath) && only.length ? JSON.parse(readFileSync(timelinePath, 'utf8')) : [];
/** Saved after every beat, in beat order, so a failed run keeps what it filmed. */
function saveTimeline() {
  const order = beats(take).map((b) => b.id);
  const kept = timeline.filter((c) => order.includes(c.id));
  kept.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  writeFileSync(timelinePath, JSON.stringify(kept, null, 2));
}
try {
  if (args.includes('--connect')) await connectWallet(browser);
  else
    for (const b of list) {
      const t = Date.now();
      const clip = await film(browser, b);
      const txs = clip?.txs.length ? ` txs ${clip.txs.map((x) => x.hash.slice(0, 10)).join(' ')}` : '';
      console.log(
        `${probe ? 'probe ok' : 'filmed  '} ${b.id.padEnd(13)} ${clip ? `${(clip.durMs / 1000).toFixed(1)}s` : ''} (${((Date.now() - t) / 1000).toFixed(1)}s)${txs}`,
      );
      if (clip) {
        const i = timeline.findIndex((c) => c.id === clip.id);
        if (i >= 0) timeline[i] = clip;
        else timeline.push(clip);
        saveTimeline();
      }
    }
} finally {
  await browser.close();
}
