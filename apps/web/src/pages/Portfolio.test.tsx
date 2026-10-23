import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { maxUint256 } from 'viem';
import type { PositionState } from '@mezodot/sdk';
import { HUB, SPOKES } from '../chain/env';
import type { ActivityItem } from '../data/activity';
import type { SpokeClaim } from '../data/claims';
import type { WalletBalances } from '../data/hooks';
import { E18, SHARE, position, visibleText } from '../test/fixtures';
import { Portfolio } from './Portfolio';

/** The portfolio page over the fixture account (see test/fixtures.ts), with the wallet, claims and history faked. */

const fake = vi.hoisted(() => ({
  connected: true,
  position: undefined as unknown,
  wallet: undefined as unknown,
  claims: [] as unknown[],
  activity: [] as unknown[],
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () =>
    fake.connected ? { address: '0x00000000000000000000000000000000000000a1', isConnected: true } : { address: undefined, isConnected: false },
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('../state/UiContext', () => ({ useUi: () => ({ go: () => {}, openModal: () => {} }) }));
vi.mock('../data/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/activity')>()),
  useActivity: () => ({ data: { items: fake.activity, spokeErrors: [] }, isError: false, error: null, refetch: async () => undefined }),
}));
vi.mock('../data/claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/claims')>()),
  useSpokeClaims: () => ({ data: { claims: fake.claims, errors: {} } }),
}));
vi.mock('../data/hooks', async (importOriginal) => {
  const f = await import('../test/fixtures');
  const sdk = await import('@mezodot/sdk');
  return {
    ...(await importOriginal<typeof import('../data/hooks')>()),
    useProtocol: () => ({ data: f.protocol }),
    usePrices: () => ({ data: { prices: f.prices, usable: f.prices, publishTime: 0, relayError: null }, isLoading: false }),
    usePosition: () => ({ data: fake.position, error: null, refetch: async () => undefined }),
    useHubStatus: () => ({ error: null, loading: false, stale: false, retrying: false, retry: () => {} }),
    useWalletBalances: () => ({ data: fake.wallet, error: fake.wallet ? null : new Error('rpc down'), refetch: async () => undefined }),
    useValuedPosition: () => {
      const pos = fake.connected ? (fake.position as PositionState) : undefined;
      return {
        valued: pos ? sdk.valuePosition(f.protocol, pos, f.prices) : null,
        position: pos,
        protocol: f.protocol,
        prices: f.prices,
        unpriced: [],
        unpricedDebts: [],
        debtFree: pos ? pos.debts.every((d) => d.amount === 0n) : false,
        relayError: null,
        isLoading: false,
      };
    },
  };
});

// 10 pMUSD (11 MUSD) still in the wallet.
const wallet: WalletBalances = {
  hub: { native: E18, tokens: { MUSD: 50n * E18, pMUSD: 10n * SHARE, MEZO: 0n, pMEZO: 0n, BTC: E18 } },
  spokes: {},
  spokeErrors: {},
};
const empty: PositionState = {
  ...position,
  collateral: position.collateral.map((c) => ({ ...c, balance: 0n })),
  debts: position.debts.map((d) => ({ ...d, amount: 0n })),
  snapshot: { ...position.snapshot, healthFactor: maxUint256 },
};

const render = () => {
  const html = renderToStaticMarkup(<Portfolio />);
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => visibleText(m[1]));
  return { text: visibleText(html), row: (needle: string) => rows.find((r) => r.includes(needle)) ?? `(no row with "${needle}")` };
};

beforeEach(() => {
  fake.connected = true;
  fake.position = position;
  fake.wallet = wallet;
  fake.claims = [];
  fake.activity = [];
});

describe('portfolio page', () => {
  it('asks for a wallet before showing anything about an account', () => {
    fake.connected = false;
    const { text } = render();
    expect(text).toContain('Connect a wallet to see your portfolio');
    expect(text).not.toContain('Net worth');
  });

  it('sums the account up: net worth, supplied, borrowed and health', () => {
    const { text } = render();
    // 11 MUSD of pMUSD in the wallet + $2,210 of collateral − $500 of debt.
    expect(text).toContain('Net worth $1,721');
    // The pMUSD in the wallet and posted: 11 + 110 MUSD.
    expect(text).toContain('Supplied $121.00');
    expect(text).toContain('Borrowed $500.00');
    expect(text).toContain('Health factor 3.52×');
  });

  it('leaves net worth unknown, never $0, when the wallet cannot be read', () => {
    fake.wallet = undefined;
    const { text } = render();
    expect(text).toContain('Net worth — Could not read your wallet balances');
    expect(text).not.toContain('Net worth $');
  });

  it('shows supplied pTokens split between the wallet and collateral', () => {
    expect(render().row('as pMUSD')).toMatch(/^MUSD as pMUSD 11\.0000 110\.0000 \$121\.00 0\.00% Supply Withdraw$/);
  });

  it('lists each collateral where it is held, and sends spoke collateral to Cross-chain to withdraw', () => {
    const { row } = render();
    expect(row('0.0100 BTC')).toBe('BTC Mezo Hub 0.0100 BTC $600.00 70% / 78% Remove');
    // Posted pMUSD is shown in the MUSD it redeems for.
    expect(row('110.0000 MUSD')).toBe('pMUSD Mezo Hub 110.0000 MUSD $110.00 80% / 85% Remove');
    expect(row('Base Sepolia')).toBe('WETH Base Sepolia 0.5000 WETH $1,500 75% / 80% Withdraw on Cross-chain');
  });

  it('lists debt with a repay action', () => {
    expect(render().row('500.00 MUSD')).toBe('MUSD 500.00 MUSD $500.00 0.00% Repay');
  });

  it('says what is empty for a wallet with no position yet', () => {
    fake.position = empty;
    fake.wallet = { ...wallet, hub: { ...wallet.hub, tokens: { ...wallet.hub.tokens, pMUSD: 0n } } };
    const { text } = render();
    expect(text).toContain('Net worth $0.00');
    expect(text).toContain('Nothing supplied yet.');
    expect(text).toContain('No collateral posted yet.');
    expect(text).toContain('No debt.');
    expect(text).toContain('Health factor — No debt');
  });

  it('flags spoke releases waiting to be claimed', () => {
    const claim: SpokeClaim = { spoke: SPOKES[0], symbol: 'WETH', token: '0x00000000000000000000000000000000000000d1', decimals: 18, amount: 2n * 10n ** 15n };
    fake.claims = [claim];
    const { text } = render();
    expect(text).toContain('Ready to claim 0.002000 WETH Held by the Base Sepolia gateway');
    expect(text).toContain('Claim on Cross-chain');
  });

  it('keeps the recent activity, with a link to the full history', () => {
    const borrow: ActivityItem = {
      id: 'borrow-1',
      kind: 'Borrow',
      network: HUB.name,
      asset: 'MUSD',
      amount: 500n * E18,
      decimals: 18,
      detail: 'From the MUSD pool',
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      blockNumber: 1n,
      timestamp: null,
    };
    fake.activity = [borrow];
    const { text } = render();
    expect(text).toContain('Recent activity');
    expect(text).toContain('Borrow 500.0000 MUSD From the MUSD pool');
    expect(text).toContain('Full history');
  });
});
