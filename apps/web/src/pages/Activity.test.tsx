import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HUB } from '../chain/env';
import type { ActivityItem } from '../data/activity';
import { E18, visibleText } from '../test/fixtures';
import { Activity } from './Activity';

/** The activity ledger over a faked history, newest first as useActivity returns it. */

const fake = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000a1', isConnected: true }),
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('../state/UiContext', () => ({ useUi: () => ({ showToast: () => {} }) }));
vi.mock('../data/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/activity')>()),
  useActivity: () => ({ data: { items: fake.items, spokeErrors: [] }, isLoading: false, isError: false, error: null, refetch: async () => undefined }),
}));
vi.mock('../data/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/hooks')>()),
  useHubStatus: () => ({ error: null, loading: false, stale: false, retrying: false, retry: () => {} }),
}));

/** Supplies of 1, 2, … MUSD, the first one newest. */
const history = (n: number): ActivityItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `supply-${i}`,
    kind: 'Supply',
    network: HUB.name,
    asset: 'MUSD',
    amount: BigInt(i + 1) * E18,
    decimals: 18,
    detail: 'Into the MUSD pool',
    txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    blockNumber: BigInt(100 - i),
    timestamp: null,
  }));

const render = () => {
  const html = renderToStaticMarkup(<Activity />);
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => visibleText(m[1]));
  const nav = html.match(/<nav class="pagination"[\s\S]*?<\/nav>/)?.[0];
  return { rows, pages: nav ? visibleText(nav) : null };
};

beforeEach(() => {
  fake.items = [];
});

describe('activity ledger', () => {
  it('shows 15 events a page, newest first, with the pages to move between', () => {
    fake.items = history(20);
    const { rows, pages } = render();
    expect(rows).toHaveLength(15);
    expect(rows[0]).toContain('1.0000 MUSD');
    expect(rows[14]).toContain('15.0000 MUSD');
    expect(rows.join(' ')).not.toContain('16.0000 MUSD');
    expect(pages).toBe('1–15 of 20 1 2');
  });

  it('fits 15 events on one page, without page controls', () => {
    fake.items = history(15);
    const { rows, pages } = render();
    expect(rows).toHaveLength(15);
    expect(pages).toBeNull();
  });
});
