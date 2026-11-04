import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { visibleText } from '../test/fixtures';
import { HUB } from '../chain/env';
import { Dashboard } from './Dashboard';

/** The protocol overview over the fixture hub (see test/fixtures.ts): 1,000 pMUSD, 2 BTC and 3 WETH on Base posted in all. */

const fake = vi.hoisted(() => ({ connected: false }));

vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () =>
    fake.connected ? { address: '0x00000000000000000000000000000000000000a1', isConnected: true } : { address: undefined, isConnected: false },
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('../state/UiContext', () => ({ useUi: () => ({ go: () => {} }) }));
vi.mock('../data/hooks', async (importOriginal) => {
  const f = await import('../test/fixtures');
  return {
    ...(await importOriginal<typeof import('../data/hooks')>()),
    useProtocol: () => ({ data: f.protocol }),
    usePrices: () => ({ data: { prices: f.prices, usable: f.prices, publishTime: 0, relayError: null }, isLoading: false }),
    useLoopStats: () => ({ data: undefined }),
    useAgent: () => ({ data: undefined }),
    useHubStatus: () => ({ error: null, loading: false, stale: false, retrying: false, retry: () => {} }),
  };
});

beforeEach(() => {
  fake.connected = false;
});

describe('protocol overview', () => {
  it('groups the collateral by chain, in plain words, with the limits and what every account has posted', () => {
    const html = renderToStaticMarkup(<Dashboard />);
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => visibleText(m[1]));
    // 1,000 pMUSD at 1.1 MUSD; 2 BTC at $60,000; 3 WETH at $3,000.
    const start = rows.indexOf('ASSET BORROW UP TO LIQUIDATED AT POSTED');
    expect(rows.slice(start, start + 7)).toEqual([
      'ASSET BORROW UP TO LIQUIDATED AT POSTED',
      HUB.label,
      'pMUSD Supplied MUSD 80% 85% $1.1K',
      'BTC 70% 78% $120.0K',
      'Base Sepolia',
      'WETH 75% 80% $9.0K',
      'Total posted by all accounts $130.1K',
    ]);
  });

  it('explains the collateral table without hub and spoke jargon, and keeps the liquidation bonus', () => {
    const html = renderToStaticMarkup(<Dashboard />);
    const text = visibleText(html);
    expect(text).toContain('Borrow on Mezo against any of these. Assets on other chains stay locked there.');
    expect(text).not.toContain('posted by every account');
    expect(text).toContain("Percentages are debt as a share of the asset's value. Liquidators earn a 5% bonus from the collateral they take.");
    expect(html).toContain('title="Liquidators earn a 5% bonus on this asset"');
  });

  it('points a connected wallet to its portfolio', () => {
    expect(visibleText(renderToStaticMarkup(<Dashboard />))).not.toContain('Your portfolio');
    fake.connected = true;
    expect(visibleText(renderToStaticMarkup(<Dashboard />))).toContain('Your portfolio');
  });
});
