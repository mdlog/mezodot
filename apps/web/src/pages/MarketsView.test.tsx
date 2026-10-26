import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HubFlags } from '../data/guards';
import type { WalletBalances } from '../data/hooks';
import { E18, SHARE, position, prices, protocol, visibleText } from '../test/fixtures';
import { MarketList, marketEntries, parseMarketsView } from './Markets';

/** The Markets list layout over the fixture hub (see test/fixtures.ts): MUSD and MEZO pools, BTC on the hub, WETH on Base. */

vi.mock('../state/UiContext', () => ({ useUi: () => ({ openModal: () => {}, go: () => {} }) }));

// 10 pMUSD (11 MUSD) and 1 BTC in the wallet; the fixture position has 100 pMUSD and 0.01 BTC posted.
const balances: WalletBalances = {
  hub: { native: E18, tokens: { MUSD: 50n * E18, pMUSD: 10n * SHARE, MEZO: 0n, pMEZO: 0n, BTC: E18 } },
  spokes: {},
  spokeErrors: {},
};
const flags: HubFlags = { vaultPaused: false, markets: { 0: { poolPaused: false, enabled: true }, 1: { poolPaused: false, enabled: true } } };

const rowsOf = (html: string) =>
  [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap((b) => [...b[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => visibleText(m[1])));

describe('markets layout', () => {
  it('keeps the layout picked, and opens on the grid otherwise', () => {
    expect(parseMarketsView('list')).toBe('list');
    expect(parseMarketsView('grid')).toBe('grid');
    expect(parseMarketsView(null)).toBe('grid');
    expect(parseMarketsView('table')).toBe('grid');
  });

  it('lists each pool and each hub collateral on one row, with the figures and actions of its card', () => {
    const entries = marketEntries({ protocol, prices, balances, position, flags, connected: true });
    const rows = rowsOf(renderToStaticMarkup(<MarketList entries={entries} />));
    // MUSD, MEZO and BTC; WETH stays on its spoke and is posted from Cross-chain.
    expect(rows).toHaveLength(3);
    // 1 pMUSD = 1.1 MUSD: 10 shares in the wallet, 100 posted. 4,000 of 10,000 MUSD lent out.
    expect(rows[0]).toBe('MUSD pMUSD · $1.00 0.00% 0.00% 40% $10.0K 6,000 MUSD 11.0000 MUSD 110.0000 MUSD Supply Withdraw Collateral Remove');
    // No pMEZO collateral is configured in the fixture, so its row offers supply and withdraw only.
    expect(rows[1]).toBe('MEZO pMEZO · $0.30000 0.00% 0.00% 40% $3.0K 6,000 MEZO 0.0000 MEZO 0.0000 MEZO Supply Withdraw');
    // BTC earns nothing and lends nothing: its row is what is posted, in total and by this wallet.
    expect(rows[2]).toBe('BTC collateral · $60,000 — — — $120.0K — 1.000000 BTC 0.010000 BTC Post Remove Leverage');
  });

  it('disables what an empty wallet cannot do, but never on balances it could not read', () => {
    const empty: WalletBalances = { ...balances, hub: { ...balances.hub, tokens: { ...balances.hub.tokens, pMEZO: 0n } } };
    const known = marketEntries({ protocol, prices, balances: empty, position, flags, connected: true });
    const mezo = known.find((e) => e.kind === 'pool' && e.market.symbol === 'MEZO');
    expect(mezo?.kind === 'pool' && mezo.noShares).toBe(true);
    const unknown = marketEntries({ protocol, prices, balances: undefined, position, flags, connected: true });
    expect(unknown.every((e) => (e.kind === 'pool' ? !e.noShares : !e.noWallet))).toBe(true);
  });
});
