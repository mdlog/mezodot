import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { visibleText } from '../test/fixtures';
import { Borrow } from './Borrow';

/** The borrow page over the fixture account (see test/fixtures.ts): $2,210 of collateral in three assets, 500 MUSD owed. */

vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000a1', isConnected: true }),
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('../chain/tx', () => ({ useTx: () => ({ run: async () => ({ ok: false }), busy: null }) }));
vi.mock('../state/UiContext', () => ({ useUi: () => ({ go: () => {}, openModal: () => {} }) }));
vi.mock('../data/guards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/guards')>()),
  useHubFlags: () => ({ data: { vaultPaused: false, markets: { 0: { poolPaused: false, enabled: true }, 1: { poolPaused: false, enabled: true } } } }),
}));
vi.mock('../data/hooks', async (importOriginal) => {
  const f = await import('../test/fixtures');
  const sdk = await import('@mezodot/sdk');
  return {
    ...(await importOriginal<typeof import('../data/hooks')>()),
    useHubClient: () => ({}),
    useHubStatus: () => ({ error: null, loading: false, stale: false, retrying: false, retry: () => {} }),
    useValuedPosition: () => ({
      valued: sdk.valuePosition(f.protocol, f.position, f.prices),
      position: f.position,
      protocol: f.protocol,
      prices: f.prices,
      unpriced: [],
      unpricedDebts: [],
      debtFree: false,
      relayError: null,
      isLoading: false,
    }),
  };
});

describe('borrow page', () => {
  it('sums the collateral up in one line and leaves the breakdown to Portfolio', () => {
    const text = visibleText(renderToStaticMarkup(<Borrow />));
    expect(text).toContain('COLLATERAL $2,210 across 3 assets View in Portfolio');
    // Amount by amount is Portfolio's job.
    expect(text).not.toContain('0.5000 WETH');
    expect(text).not.toContain('0.0100 BTC');
  });

  it('keeps the health the next borrow is measured against beside the form', () => {
    const text = visibleText(renderToStaticMarkup(<Borrow />));
    expect(text).toContain('Position health');
    // Borrow limit $1,633 − $500 owed.
    expect(text).toContain('Available $1,133');
  });
});
