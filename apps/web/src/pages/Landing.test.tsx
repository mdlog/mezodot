import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { visibleText } from '../test/fixtures';
import { Landing } from './Landing';

/** The landing page over the fixture hub (see test/fixtures.ts): WETH on Base at 75% LTV / 80% threshold, ETH at $3,000. */

vi.mock('../state/UiContext', () => ({ useUi: () => ({ go: () => {} }) }));
vi.mock('../data/hooks', async (importOriginal) => {
  const f = await import('../test/fixtures');
  const delivered = Array.from({ length: 6 }, (_, i) => ({
    direction: 'deposit',
    source: 'base-sepolia',
    target: 'mezo-testnet',
    status: 'delivered',
    id: `m${i}`,
  }));
  const agent: Record<string, unknown> = {
    '/stats': { crossChainBorrowRatio: 0.0374, borrowers: 2 },
    '/messages?limit=500': delivered,
    '/messages': delivered,
    '/liquidatable': [],
  };
  return {
    ...(await importOriginal<typeof import('../data/hooks')>()),
    useProtocol: () => ({ data: f.protocol }),
    usePrices: () => ({ data: { prices: f.prices, usable: f.prices, publishTime: 0, relayError: null }, isLoading: false }),
    useHubStatus: () => ({ error: null, loading: false, stale: false, retrying: false, retry: () => {} }),
    useLoopStats: () => ({ data: undefined }),
    useAgent: (path: string) => ({ data: agent[path] }),
  };
});

const page = () => {
  const html = renderToStaticMarkup(<Landing />);
  return { html, text: visibleText(html) };
};

describe('landing page', () => {
  it('says what Mezodot does before anything else, under the brand line', () => {
    const { text } = page();
    // The chain names are spans with their logos: tag stripping leaves a space before the full stop that a browser does not show.
    expect(text.replace(/\s+([.,])/g, '$1')).toContain('Capital, in motion. Lock on Base or Ethereum. Borrow on Mezo.');
    expect(text).toContain('Live on Mezo Testnet');
  });

  it('walks through the cross-chain path and the leverage products in order', () => {
    const { text } = page();
    const chapters = [
      'Lock WETH or USDC where it already is',
      'Guardians sign the deposit',
      'Mezo credits your collateral',
      'Borrow MUSD or MEZO',
      'Loop MUSD in one transaction',
      'Go long BTC through Tigris',
      'Take it home when your health allows',
    ].map((title) => text.indexOf(title));
    expect(chapters.every((at) => at >= 0)).toBe(true);
    expect([...chapters].sort((a, b) => a - b)).toEqual(chapters);
    // Loan-to-value read from the hub, not typed into the page.
    expect(text).toContain('WETH 75%');
  });

  it('simulates a position from live prices and the hub’s own loan-to-value', () => {
    const { text } = page();
    // 0.5 WETH at $3,000; 75% LTV; half of the 1,125 MUSD limit borrowed; 80% threshold.
    expect(text).toContain('Collateral $1,500');
    expect(text).toContain('Borrow limit 1,125 MUSD');
    expect(text).toContain('You borrow 562.50 MUSD');
    expect(text).toContain('Health factor 2.13×');
    expect(text).toContain('Liquidated if ETH falls to $1,406');
  });

  it('states the safety guarantees as the contracts enforce them', () => {
    const { text } = page();
    expect(text).toContain('ETH, USDC and BTC also carry a Supra pull proof as a second source.');
    expect(text).not.toContain('Two price sources');
    expect(text).toContain('Pausing stops new supply, borrowing and flash loans. Repaying, withdrawing and liquidations keep working.');
  });

  it('links every app page from the footer, Portfolio included', () => {
    const { html } = page();
    for (const view of ['dashboard', 'markets', 'portfolio', 'activity', 'crosschain', 'borrow', 'loop', 'architecture', 'agents']) {
      expect(html).toContain(`href="#/${view}"`);
    }
  });
});
