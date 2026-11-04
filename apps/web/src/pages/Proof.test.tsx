import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HUB } from '../chain/env';
import { PROOF, PROOF_CONTRACTS } from '../data/proof';
import { Proof } from './Proof';

const allTxs = PROOF.flatMap((s) => s.txs);

describe('proof page', () => {
  it('links every transaction to its explorer', () => {
    const html = renderToStaticMarkup(<Proof />);
    for (const tx of allTxs) expect(html).toContain(`/tx/${tx.hash}`);
  });

  it('lists only full 32-byte hashes, each once', () => {
    for (const tx of allTxs) expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(allTxs.map((t) => t.hash)).size).toBe(allTxs.length);
  });

  it('points at the source of every recorded contract', () => {
    const html = renderToStaticMarkup(<Proof />);
    for (const { key } of PROOF_CONTRACTS) expect(html).toContain(`${HUB.chain.id}/${HUB.deployment!.contracts[key]}`);
  });

  it('says plainly that the liquidation was staged', () => {
    expect(renderToStaticMarkup(<Proof />)).toMatch(/staged in the open/);
  });

  it('matches docs/EVIDENCE.md, hash for hash', () => {
    const evidence = readFileSync(fileURLToPath(new URL('../../../../docs/EVIDENCE.md', import.meta.url)), 'utf8');
    for (const tx of allTxs) expect(evidence).toContain(tx.hash);
  });
});
