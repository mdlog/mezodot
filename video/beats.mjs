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
  TWAP: 'tee wap',
  "pMEZO's": "P Mezo's",
  "MEZO's": "Mezo's",
};

/** Off camera: a borrow reverts on a stale price, and Mezo pushes MUSD and MEZO about hourly. */
async function pricesFresh() {
  for (let i = 0; i < 70; i++) {
    const feeds = (await (await fetch(`${AGENT}/oracle/health`)).json()).feeds ?? [];
    const pushed = feeds.filter((f) => f.symbol === 'MUSD' || f.symbol === 'MEZO');
    if (pushed.length === 2 && pushed.every((f) => f.status === 'ok' && f.validForSec > 300)) return;
    console.log(`  waiting for fresh prices (${pushed.map((f) => `${f.symbol} ${f.status}, valid ${f.validForSec}s`).join('; ') || 'no feeds'})`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  throw new Error('prices stayed stale for 70 minutes');
}

/** @param {object} take the live facts from select.mjs */
export function beats(take) {
  const { contracts, deployment, explorer, revenue, shots } = take;
  const { trove } = PLAN;
  return [
    {
      id: 'intro',
      chapter: 'Mezodot in one line',
      route: '#/',
      ready: 'text=Capital,',
      chip: 'mezodot · landing',
      lowerThird: { title: 'Mezodot Protocol', sub: 'Mezo Buildathon · Wave 2 · Track 1 · DeFi' },
      narration: 'Mezodot is a money market for MUSD and MEZO on Mezo, live on testnet. ' + 'Every transaction you see here is real, signed by a demo wallet.',
      actions: [{ at: 'live on testnet', do: (h) => h.hover('text=Live on Mezo Testnet') }],
      minMs: 6000,
    },
    {
      id: 'trove-open',
      chapter: 'New: BTC to a Mezo trove to pMUSD (live tx)',
      route: '#/trove',
      ready: 'text=Open and supply',
      wallet: true,
      awaitToast: true,
      chip: 'mezodot · /trove',
      narration:
        `New in Wave 2: a Mezo trove in one transaction. Post ${trove.btc} BTC and mint ${trove.musd} MUSD. ` +
        "The page previews Mezo's fee, debt and ratio. Sign Mezo's typed message, and the router opens the trove and supplies the MUSD to pMUSD.",
      actions: [
        { at: `Post ${trove.btc}`, do: (h) => h.fill('#trove-btc', trove.btc) },
        { at: `mint ${trove.musd}`, do: (h) => h.fill('#trove-debt', trove.musd) },
        { at: 'previews', do: (h) => h.hover('text=Collateral ratio') },
        { at: "Sign Mezo's", send: true, do: (h) => h.click('button:has-text("Sign and open")') },
      ],
      minMs: 6000,
    },
    {
      id: 'trove-close',
      chapter: 'Repay or close the trove from supply (live tx)',
      route: '#/trove',
      ready: 'text=Your trove',
      wallet: true,
      awaitToast: true,
      chip: 'mezodot · /trove',
      narration:
        'That supply can then repay the trove or close it. Closing takes a little MUSD on top, and all the BTC comes back. ' +
        'Today pMUSD pays less than a trove costs, and the page shows both rates.',
      actions: [
        { at: 'repay the trove', do: (h) => h.hover('#trove-repay') },
        { at: 'Closing takes', send: true, do: (h) => h.click('button:has-text("Sign and close trove")') },
        { at: 'shows both rates', do: (h) => h.hover('text=pMUSD supply APY') },
      ],
      minMs: 6000,
    },
    {
      id: 'mezo-borrow',
      chapter: 'Borrow MEZO (live tx)',
      route: '#/borrow',
      ready: 'text=Position health',
      wallet: true,
      awaitToast: true,
      before: pricesFresh,
      chip: 'mezodot · /borrow',
      narration: `The MEZO market is live too. Borrow ${PLAN.borrowMezo} MEZO against BTC in one transaction, under the same health factor.`,
      actions: [
        { at: 'The MEZO market', do: (h) => h.click('.market-switch button:has-text("MEZO")') },
        { at: 'live too', do: (h) => h.fill('#borrow-amount', PLAN.borrowMezo) },
        { at: `Borrow ${PLAN.borrowMezo}`, send: true, do: (h) => h.click('button:has-text("Borrow MEZO")') },
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
      before: pricesFresh,
      chip: 'mezodot · /loop',
      narration: 'A BTC long is one transaction as well: a Tigris flash swap buys the BTC, and the loan pays the pool back.',
      actions: [
        { at: 'A BTC long', do: (h) => h.fill('#btc-amount', PLAN.btcLong.btc) },
        { at: 'a Tigris flash swap', send: true, do: (h) => h.click(`button:has-text("Open ${PLAN.btcLong.leverage}× BTC")`) },
      ],
      minMs: 6000,
    },
    {
      id: 'crosschain',
      chapter: 'Collateral on another chain',
      route: '#/crosschain',
      ready: 'text=Withdraw to a spoke',
      ready2: `text=${PLAN.lockedWeth} WETH`,
      wallet: true,
      chip: 'mezodot · /crosschain',
      narration: 'Collateral can also stay on another chain. This WETH was locked on Base Sepolia, and a Wormhole message credited it on the hub.',
      actions: [
        { at: 'another chain', do: (h) => h.hover('text=Post cross-chain collateral') },
        { at: 'This WETH', do: (h) => h.hover(`text=${PLAN.lockedWeth} WETH`) },
      ],
      minMs: 5000,
    },
    {
      id: 'checks',
      chapter: 'Price legs and live checks',
      terminal: true,
      chip: 'live checks · terminal',
      narration:
        "Prices no longer rest on one source. BTC reads Mezo's Skip feed first, and a Tigris TWAP backs up MUSD. " +
        `All ${contracts.passed} contract tests pass, and so do all ${deployment.passed} live deployment checks.`,
      actions: [
        { at: 'Prices no longer', do: (h) => h.reveal(1) },
        { at: `All ${contracts.passed}`, do: (h) => h.reveal(2) },
        { at: 'and so do', do: (h) => h.reveal(3) },
      ],
      minMs: 7000,
    },
    {
      id: 'proof',
      chapter: 'On-chain proof and verified sources',
      route: '#/proof',
      ready: 'text=See it on-chain.',
      shot: shots.explorer,
      chip: 'mezodot · /proof, then explorer.test.mezo.org',
      narration:
        "This page lists every path with its transaction: MEZO borrows, pMEZO as collateral, and the agent's own liquidation. " +
        "We staged that one by lowering pMEZO's limits, and the agent found it unprompted. " +
        `All ${explorer.verified} hub contracts are verified on Mezo's explorer.`,
      actions: [
        { at: 'MEZO borrows', do: (h) => h.hover('text=MEZO market') },
        { at: 'pMEZO as collateral', do: (h) => h.hover('text=pMEZO as collateral') },
        { at: "the agent's own", do: (h) => h.hover('text=Keeper liquidation') },
        { at: 'We staged', do: (h) => h.hover('text=Owner lowers pMEZO limits') },
        { at: `All ${explorer.verified} hub`, do: (h) => h.showShot() },
      ],
      minMs: 7000,
      tailMs: 1600, // keep the explorer page on screen once the narration has named it
    },
    {
      id: 'revenue',
      chapter: 'Revenue',
      route: '#/dashboard',
      ready: 'text=Flash-loan fee',
      chip: 'mezodot · /dashboard',
      narration: `The protocol earns ${revenue.reserveFactorPct} percent of interest, ${revenue.flashFeePct} percent of flash loans, and ${revenue.liquidationFeePct} percent of liquidation bonuses.`,
      actions: [
        { at: 'percent of interest', offsetMs: -700, do: (h) => h.hover('text=reserve factor') },
        { at: 'percent of flash', offsetMs: -700, do: (h) => h.hover('text=Flash-loan fee') },
        { at: 'percent of liquidation', offsetMs: -700, do: (h) => h.hover('text=Liquidation fee') },
      ],
      minMs: 5000,
    },
    {
      id: 'outro',
      chapter: 'Try it',
      card: 'outro',
      chip: 'mezodot.mdloglabs.org',
      narration: 'Mezodot is not audited, and it needs outside testers. Try it on testnet, and tell us what breaks.',
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
