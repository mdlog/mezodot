// The demo's beats: what is on screen, what the narration says, and which on-screen actions are anchored to which
// spoken phrase. Every number the narration says comes from take.json (select.mjs) or the demo plan (plan.mjs), never
// typed in here. Actions marked `send` submit a transaction from the demo wallet; a probe skips them.
//
//   node video/beats.mjs out/take.json out/beats.json   # dump narration (display + spoken text) for tts.py / captions.py

import { readFileSync, writeFileSync } from 'node:fs';
import { AGENT } from './config.mjs';
import { PLAN } from './plan.mjs';

/** How the voice should say a written token; captions keep the written form. */
export const PRONOUNCE = {
  Mezodot: 'Mezo dot',
  MUSD: 'M U S D',
  pMUSD: 'P M U S D',
  MEZO: 'Mezo',
  pMEZO: 'P Mezo',
  'ERC-4626': 'E R C forty-six twenty-six',
  WETH: 'weth',
  USDC: 'U S D C',
  BTC: 'B T C',
  SpokeGateway: 'Spoke Gateway',
  KeeperGateway: 'Keeper Gateway',
  'VaR-based': 'VaR based',
  MCP: 'M C P',
  HTTP: 'H T T P',
  Sourcify: 'Source ify',
};

/** Off camera: MUSD's single price leg must stay fresh through the take, or a borrow would revert on camera. */
async function musdPriceFresh() {
  for (let i = 0; i < 70; i++) {
    const feeds = (await (await fetch(`${AGENT}/oracle/health`)).json()).feeds ?? [];
    const musd = feeds.find((f) => f.symbol === 'MUSD');
    if (musd?.status === 'ok' && musd.validForSec > 300) return;
    console.log(`  waiting for a fresh MUSD price (${musd ? `${musd.status}, valid ${musd.validForSec}s` : 'no feed'})`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  throw new Error('MUSD price stayed stale for 70 minutes');
}

/** Off camera: waits until the agent reports the filmed WETH lock's Wormhole message delivered on the hub (after
 *  Base finality). The lock's transaction comes from the timeline the lock beat wrote. */
async function lockDelivered() {
  const lock = JSON.parse(readFileSync(new URL('./out/timeline.json', import.meta.url), 'utf8')).find((c) => c.id === 'lock');
  const hash = lock?.txs?.[0]?.hash;
  if (!hash) throw new Error('film the lock beat first: no lock transaction in the timeline');
  const started = Date.now();
  for (;;) {
    const list = await (await fetch(`${AGENT}/messages?limit=100`)).json();
    const msg = (Array.isArray(list) ? list : (list.messages ?? [])).find((m) => m.txHash?.toLowerCase() === hash.toLowerCase());
    console.log(`  lock message: ${msg ? msg.status : 'not seen yet'}, ${Math.round((Date.now() - started) / 60_000)} min`);
    if (msg?.status === 'delivered') return;
    if (Date.now() - started > 60 * 60_000) throw new Error('lock message not delivered within an hour');
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

const musdCard = '.market-detail-card:has-text("MUSD")';

/** @param {object} take the live facts from select.mjs */
export function beats(take) {
  const { contracts, deployment, sourcify } = take;
  const loopPosition = Number(PLAN.loop.principalMusd) * PLAN.loop.leverage;
  return [
    {
      id: 'intro',
      chapter: 'Mezodot in one line',
      route: '#/',
      ready: 'text=Capital,',
      chip: 'mezodot · landing',
      lowerThird: { title: 'Mezodot Protocol', sub: 'Mezo Buildathon · Track 1 · DeFi' },
      narration:
        'Mezodot makes MUSD and MEZO productive on Mezo: an omnichain money market, live on testnet. ' +
        'Every transaction you see here is real, signed by a fresh demo wallet.',
      actions: [{ at: 'live on testnet', do: (h) => h.hover('text=Live on Mezo Testnet') }],
      minMs: 6000,
    },
    {
      id: 'supply',
      chapter: 'Supply MUSD, receive pMUSD (live tx)',
      route: '#/markets',
      ready: 'text=Markets & vaults',
      ready2: '.market-detail-card',
      wallet: true,
      awaitToast: true,
      chip: 'mezodot · /markets',
      narration: `Supply ${PLAN.supplyMusd} MUSD, and the pool mints pMUSD: an ERC-4626 share that earns borrower interest and can be posted as collateral.`,
      actions: [
        { at: 'Supply', do: (h) => h.click(`${musdCard} button:text-is("Supply")`) },
        { at: `${PLAN.supplyMusd} MUSD`, do: (h) => h.fill('#modal-amount', PLAN.supplyMusd) },
        { at: 'the pool mints', send: true, do: (h) => h.click('form button[type=submit]') },
      ],
      minMs: 6000,
    },
    {
      id: 'loop',
      chapter: '1-click MUSD loop (live tx)',
      route: '#/loop',
      ready: 'text=Leverage desk.',
      wallet: true,
      awaitToast: true,
      before: musdPriceFresh,
      chip: 'mezodot · /loop',
      narration: `Now loop it: ${PLAN.loop.principalMusd} MUSD becomes a ${loopPosition} MUSD position in one transaction, through the pool's own flash loan.`,
      actions: [
        { at: 'Now loop it', do: (h) => h.click('[role="tab"]:has-text("MUSD loop")') },
        { at: `${PLAN.loop.principalMusd} MUSD becomes`, do: (h) => h.fill('#loop-amount', PLAN.loop.principalMusd) },
        { at: 'in one transaction', send: true, do: (h) => h.click(`button:has-text("Open ${PLAN.loop.leverage}× loop")`) },
      ],
      minMs: 6000,
    },
    {
      id: 'btc-long',
      chapter: 'One-transaction BTC long via Tigris (live tx)',
      route: '#/loop',
      ready: 'text=Configure your BTC position',
      wallet: true,
      awaitToast: true,
      before: musdPriceFresh,
      chip: 'mezodot · /loop',
      narration:
        'A BTC long is one transaction too: Tigris sends the BTC first in a flash swap, then Mezodot posts it ' +
        'and borrows exactly the MUSD that pays the pool, with no flash fee.',
      actions: [
        { at: 'A BTC long', do: (h) => h.fill('#btc-amount', PLAN.btcLong.btc) },
        { at: 'Tigris sends', send: true, do: (h) => h.click(`button:has-text("Open ${PLAN.btcLong.leverage}× BTC")`) },
      ],
      minMs: 6000,
    },
    {
      id: 'position',
      chapter: 'One health factor',
      route: '#/borrow',
      ready: 'text=Position health',
      wallet: true,
      chip: 'mezodot · /borrow',
      narration: 'Both positions share one health factor, priced live by Pyth and Supra.',
      actions: [
        { at: 'one health factor', do: (h) => h.hover('text=Position health') },
        { at: 'priced live', do: (h) => h.hover('text=Collateral value') },
      ],
      minMs: 5000,
    },
    {
      id: 'lock',
      chapter: 'Lock WETH on Base Sepolia (live tx)',
      route: '#/crosschain',
      ready: 'text=Post cross-chain collateral',
      wallet: true,
      awaitToast: true,
      chip: 'mezodot · /crosschain',
      narration: 'Collateral can also stay on Base: lock WETH in the SpokeGateway, and a guardian-signed Wormhole message carries it to the Mezo hub.',
      actions: [
        { at: 'lock WETH', do: (h) => h.fill('#bridge-amount', PLAN.lockWeth) },
        { at: 'in the SpokeGateway', send: true, do: (h) => h.click('button:has-text("Lock on")') },
      ],
      minMs: 6000,
    },
    {
      id: 'credit',
      chapter: 'Credited on the Mezo hub after Base finality',
      route: '#/crosschain',
      ready: 'text=Withdraw to a spoke',
      ready2: `text=${PLAN.lockWeth} WETH`,
      wallet: true,
      before: lockDelivered,
      chip: 'mezodot · /crosschain',
      narration: 'Once Base finalises, our keeper relays the message, and the hub credits the WETH under the same health factor.',
      actions: [
        { at: 'our keeper relays', do: (h) => h.hover('text=Withdraw to a spoke') },
        { at: 'the hub credits', do: (h) => h.hover(`text=${PLAN.lockWeth} WETH`) },
        { at: 'same health factor', do: (h) => h.hover('text=Health factor') },
      ],
      minMs: 5000,
    },
    {
      id: 'activity',
      chapter: 'Everything on-chain',
      route: '#/activity',
      ready: 'text=Every move, accounted for.',
      ready2: 'table tbody tr', // the ledger scans contract events: rows can take ~40 s
      wallet: true,
      chip: 'mezodot · /activity',
      narration: 'Every step is on-chain: the activity view reads it straight from contract events on the hub and the spoke.',
      actions: [
        { at: 'Every step', do: (h) => h.hover('table tbody tr') },
        { at: 'contract events', do: (h) => h.hover('table tbody tr:nth-child(4)') },
      ],
      minMs: 5000,
    },
    {
      id: 'proof',
      chapter: 'Tests, deployment check and verified sources',
      terminal: true,
      chip: 'live checks · terminal + sourcify.dev',
      narration:
        `Under the hood, ${contracts.passed} contract tests pass, including invariant suites, ` +
        `the live deployment check passes all ${deployment.passed} checks, ` +
        `and all ${sourcify.exact} contracts are exact matches on Sourcify.`,
      actions: [
        { at: `${contracts.passed} contract tests`, do: (h) => h.reveal(1) },
        { at: 'live deployment check', do: (h) => h.reveal(2) },
        { at: `all ${sourcify.exact} contracts`, do: (h) => h.reveal(3) },
        { at: 'exact matches on Sourcify', do: (h) => h.showShot() },
      ],
      minMs: 7000,
      tailMs: 2600, // keep the Sourcify page on screen once the narration has named it
    },
    {
      id: 'outro',
      chapter: 'Mezodot',
      card: 'outro',
      chip: 'github.com/mdlog/mezodot',
      narration: 'Mezodot: productive MUSD and MEZO across chains, with permissionless keepers and an MCP server for AI agents. Built on Mezo.',
      actions: [],
      minMs: 5000,
    },
  ];
}

/** Written tokens of a narration, each with its spoken form (for TTS) and its words as the voice says them. */
export function tokens(narration) {
  return narration
    .split(/\s+/)
    .filter(Boolean)
    .map((written) => {
      const m = written.match(/^(.*?)([.,:;!?]*)$/);
      const core = m[1];
      const punct = m[2];
      const spoken = (PRONOUNCE[core] ?? core) + punct;
      return { written, spoken, words: spoken.split(/\s+/) };
    });
}

/** The text the voice reads: every token in its spoken form. */
export const spokenText = (narration) =>
  tokens(narration)
    .map((t) => t.spoken)
    .join(' ');

if (import.meta.url === `file://${process.argv[1]}`) {
  const [takePath, outPath] = process.argv.slice(2);
  const take = JSON.parse(readFileSync(takePath, 'utf8'));
  const dump = beats(take).map((b) => ({
    id: b.id,
    chapter: b.chapter,
    chip: b.chip,
    minMs: b.minMs,
    tailMs: b.tailMs ?? 400,
    narration: b.narration,
    spoken: spokenText(b.narration),
    tokens: tokens(b.narration).map(({ written, words }) => ({ written, words })),
  }));
  writeFileSync(outPath, JSON.stringify(dump, null, 2));
  console.log(`beats: ${dump.length}, words: ${dump.reduce((n, b) => n + b.tokens.length, 0)}`);
}
