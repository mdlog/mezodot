import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { visibleText } from '../test/fixtures';
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
  it('lists the collateral the hub accepts on every chain: thresholds, bonus and what is posted in total', () => {
    const html = renderToStaticMarkup(<Dashboard />);
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => visibleText(m[1]));
    // 1,000 pMUSD at 1.1 MUSD; 2 BTC at $60,000; 3 WETH at $3,000.
    expect(rows).toContain('pMUSD Mezo Hub 80% 85% 5% $1.1K');
    expect(rows).toContain('BTC Mezo Hub 70% 78% 5% $120.0K');
    expect(rows).toContain('WETH Base Sepolia 75% 80% 5% $9.0K');
  });

  it('points a connected wallet to its portfolio', () => {
    expect(visibleText(renderToStaticMarkup(<Dashboard />))).not.toContain('Your portfolio');
    fake.connected = true;
    expect(visibleText(renderToStaticMarkup(<Dashboard />))).toContain('Your portfolio');
  });
});
