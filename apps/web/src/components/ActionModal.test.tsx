import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { maxUint256, zeroHash, type Address } from 'viem';
import { PRICE_KEYS, type CollateralState, type MarketState, type PositionState, type ProtocolState, type ValuedPosition } from '@mezodot/sdk';
import type { HubFlags } from '../data/guards';
import type { WalletBalances } from '../data/hooks';
import { MEZO_BTC } from '../lib/btc';
import type { AmountModal } from '../state/UiContext';
import { ActionModal } from './ActionModal';

/** The hub action bodies wired to fake reads: cap-aware MAX, switch and cap reasons, and a failed balance read. */

const E18 = 10n ** 18n;
const SHARE = 10n ** 24n;
const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';
const POOL: Address = '0x00000000000000000000000000000000000000b1';

// 1,000 MUSD supplied, 400 lent out; 1 pMUSD = 1.1 MUSD.
const musd: MarketState = {
  id: 0,
  symbol: 'MUSD',
  receiptSymbol: 'pMUSD',
  pool: POOL,
  asset: '0x00000000000000000000000000000000000000c1',
  decimals: 18,
  shareDecimals: 24,
  priceKey: PRICE_KEYS.MUSD,
  totalAssets: 1_000n * E18,
  totalBorrows: 400n * E18,
  totalReserves: 0n,
  cash: 600n * E18,
  totalSupply: 909n * SHARE,
  exchangeRate: 11n * 10n ** 17n,
  borrowRatePerSecond: 0n,
  supplyRatePerSecond: 0n,
  supplyCap: maxUint256,
  borrowCap: maxUint256,
  reserveFactor: 10n ** 17n,
};
const collateral = (patch: Partial<CollateralState>): CollateralState => ({
  id: 0,
  enabled: true,
  isRemote: false,
  isShare: true,
  token: POOL,
  chainId: 0,
  remoteToken: zeroHash,
  decimals: 24,
  priceKey: PRICE_KEYS.MUSD,
  ltvBps: 8_000,
  ltBps: 8_500,
  bonusBps: 500,
  cap: maxUint256,
  total: 0n,
  symbol: 'pMUSD',
  ...patch,
});
const pMusd = collateral({});
const btc = collateral({
  id: 1,
  isShare: false,
  token: MEZO_BTC as Address,
  decimals: 18,
  priceKey: PRICE_KEYS.BTC,
  ltvBps: 7_000,
  ltBps: 7_800,
  symbol: 'BTC',
});
const position: PositionState = {
  account: ACCOUNT,
  snapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: 0n, healthFactor: maxUint256 },
  collateral: [
    { id: 0, balance: 0n, valueUsd: 0n },
    { id: 1, balance: 0n, valueUsd: 0n },
  ],
  debts: [{ marketId: 0, amount: 0n }],
  isLeverageOperator: false,
  isSwapLeverageOperator: false,
};
const wallet: WalletBalances = { hub: { native: E18, tokens: { MUSD: 50n * E18, pMUSD: 10n * SHARE, BTC: E18 } }, spokes: {}, spokeErrors: {} };
// $1,000 of borrowing power left, no debt.
const valued = {
  availableUsd: 1_000,
  adjustedCollateralUsd: 1_200,
  debtUsd: 0,
  healthFactor: Infinity,
  collateral: [],
  debts: [],
} as unknown as ValuedPosition;

const fake = vi.hoisted(() => ({
  modal: null as unknown,
  protocol: undefined as unknown,
  flags: undefined as unknown,
  balances: {} as { data?: unknown; error?: unknown; refetch: () => Promise<unknown> },
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000a1', isConnected: true }),
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('../chain/tx', () => ({ useTx: () => ({ run: async () => ({ ok: false }), busy: null }) }));
vi.mock('../state/UiContext', () => ({ useUi: () => ({ modal: fake.modal, closeModal: () => {} }) }));
vi.mock('../data/guards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/guards')>()),
  useHubFlags: () => ({ data: fake.flags }),
}));
vi.mock('../data/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/hooks')>()),
  useHubClient: () => ({}),
  useProtocol: () => ({ data: fake.protocol }),
  useHubStatus: () => ({ error: null, loading: false, stale: false, retrying: false, retry: () => {} }),
  useWalletBalances: () => fake.balances,
  useValuedPosition: () => {
    const protocol = fake.protocol as ProtocolState | undefined;
    return {
      valued,
      protocol,
      prices: { MUSD: 1, BTC: 60_000 },
      position,
      unpriced: [],
      unpricedDebts: [],
      debtFree: true,
      relayError: null,
      isLoading: false,
    };
  },
}));

const open = (modal: AmountModal, { markets = [musd], collaterals = [pMusd, btc] }: { markets?: MarketState[]; collaterals?: CollateralState[] } = {}) => {
  fake.modal = modal;
  fake.protocol = { markets, collaterals, keeperCount: 1n, blockNumber: 1n, liquidationFeeBps: 1_000, treasury: ACCOUNT } satisfies ProtocolState;
  const html = renderToStaticMarkup(<ActionModal />);
  return {
    // Visible text, as a reader sees it (React's text separators and tags dropped, entities decoded).
    text: html
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, ' '),
    submit: html.match(/<button type="submit"[^>]*>/)?.[0] ?? null,
  };
};

beforeEach(() => {
  fake.flags = { vaultPaused: false, markets: { 0: { poolPaused: false, enabled: true } } } satisfies HubFlags;
  fake.balances = { data: wallet, error: null, refetch: async () => undefined };
});

describe('hub action modal', () => {
  it('caps supply at the room under the supply cap and shows that limit exactly', () => {
    const { text, submit } = open({ type: 'supply', marketId: 0, preset: '30' }, { markets: [{ ...musd, supplyCap: 1_020n * E18 }] });
    expect(text).toContain('Max 20 MUSD');
    expect(text).toContain('Amount exceeds what the MUSD pool still accepts under its supply cap: at most 20 MUSD.');
    expect(submit).toContain('disabled');
  });

  it('disables supply with the reason when the pool is paused', () => {
    fake.flags = { vaultPaused: false, markets: { 0: { poolPaused: true, enabled: true } } } satisfies HubFlags;
    const { text, submit } = open({ type: 'supply', marketId: 0, preset: '10' });
    expect(text).toContain('The MUSD pool is paused: new supply is blocked. Withdrawals still work.');
    expect(submit).toMatch(/disabled="" title="The MUSD pool is paused/);
    expect(text).not.toContain('Amount exceeds');
  });

  it('caps borrowing at the borrow cap, and borrowing does not wait on the wallet', () => {
    fake.balances = { data: undefined, error: new Error('rpc down'), refetch: async () => undefined };
    const { text, submit } = open({ type: 'borrow', marketId: 0, preset: '60' }, { markets: [{ ...musd, borrowCap: 450n * E18 }] });
    expect(text).toContain('Max 50 MUSD');
    expect(text).toContain('Amount exceeds what the MUSD pool can still lend under its borrow cap: at most 50 MUSD.');
    expect(submit).toContain('disabled');
    expect(text).not.toContain('Could not read');
  });

  it('disables borrowing with the reason when the market is switched off', () => {
    fake.flags = { vaultPaused: false, markets: { 0: { poolPaused: false, enabled: false } } } satisfies HubFlags;
    const { text, submit } = open({ type: 'borrow', marketId: 0, preset: '10' });
    expect(text).toContain('Borrowing MUSD is switched off right now.');
    expect(submit).toContain('disabled');
  });

  it('caps posted pool shares at the collateral cap, in underlying', () => {
    // 4 shares of room, worth 4.4 MUSD; the wallet holds 10.
    const { text, submit } = open({ type: 'post', collateralId: 0, preset: '5' }, { collaterals: [{ ...pMusd, cap: 10n * SHARE, total: 6n * SHARE }, btc] });
    expect(text).toContain('Max 4.4 MUSD');
    expect(text).toContain('Amount exceeds what pMUSD collateral still accepts under its cap: at most 4.4 MUSD.');
    expect(submit).toContain('disabled');
    expect(
      open({ type: 'post', collateralId: 0, preset: '4.4' }, { collaterals: [{ ...pMusd, cap: 10n * SHARE, total: 6n * SHARE }, btc] }).submit,
    ).not.toContain('disabled');
  });

  it('names a failed balance read with a retry instead of a max that never loads', () => {
    fake.balances = { data: undefined, error: new Error('rpc down'), refetch: async () => undefined };
    for (const modal of [
      { type: 'supply', marketId: 0 },
      { type: 'post', collateralId: 0 },
      { type: 'post', collateralId: 1 },
    ] as AmountModal[]) {
      const { text, submit } = open(modal);
      expect(text).toContain('Could not read your wallet balances: rpc down. Retry');
      expect(submit).toBeNull();
    }
  });

  it('caps posted BTC at its collateral cap and blocks collateral that is switched off', () => {
    const capped = open({ type: 'post', collateralId: 1, preset: '0.5' }, { collaterals: [pMusd, { ...btc, cap: 3n * 10n ** 17n, total: 0n }] });
    expect(capped.text).toContain('Max 0.3 BTC');
    expect(capped.text).toContain('Amount exceeds what BTC collateral still accepts under its cap: at most 0.3 BTC.');
    // Uncapped: the wallet less the gas reserve.
    expect(open({ type: 'post', collateralId: 1, preset: '2' }).text).toContain(
      'Amount exceeds your BTC wallet balance (keeping 0.0002 BTC for gas): at most 0.9998 BTC.',
    );
    const off = open({ type: 'post', collateralId: 1, preset: '0.1' }, { collaterals: [pMusd, { ...btc, enabled: false }] });
    expect(off.text).toContain('BTC is not accepted as new collateral right now.');
    expect(off.submit).toMatch(/disabled="" title="BTC is not accepted/);
  });
});
