import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TROVE_STATUS, type TroveState } from '@mezodot/sdk';
import type { TroveWallet } from '../data/trove';
import { visibleText } from '../test/fixtures';
import { Trove } from './Trove';

const WAD = 10n ** 18n;
const state: { wallet: TroveWallet | undefined } = { wallet: undefined };

vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000a1', isConnected: true }),
  useSignTypedData: () => ({ signTypedDataAsync: async () => '0x' }),
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('../chain/tx', () => ({ useTx: () => ({ run: async () => ({ ok: false }), busy: null }) }));
vi.mock('../data/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/hooks')>()),
  useHubClient: () => ({}),
  useProtocol: () => ({ data: undefined }),
  useTrove: () => ({ data: state.wallet }),
}));

const trove = (patch: Partial<TroveState> = {}): TroveState => ({
  price: 78_000n * WAD,
  tcr: (278n * WAD) / 100n,
  recoveryMode: false,
  borrowingRate: WAD / 1000n,
  redemptionRate: 0n,
  interestRateBps: 100,
  systemColl: 15_000n * WAD,
  systemDebt: 400_000_000n * WAD,
  status: TROVE_STATUS.NONE,
  coll: 0n,
  debt: 0n,
  icr: 0n,
  maxBorrowingCapacity: 0n,
  surplus: 0n,
  nonce: 0n,
  isContract: false,
  ...patch,
});
const wallet = (patch: Partial<TroveState> = {}, rest: Partial<TroveWallet> = {}): TroveWallet => ({
  trove: trove(patch),
  btc: WAD,
  musd: 10n * WAD,
  shares: 0n,
  supplyAssets: 0n,
  ...rest,
});
const render = () => visibleText(renderToStaticMarkup(<Trove />));

describe('trove page', () => {
  beforeEach(() => {
    state.wallet = wallet();
  });

  it('offers the one-transaction open without a trove', () => {
    const text = render();
    expect(text).toContain('Open and supply');
    expect(text).toContain('Sign and open');
    expect(text).toContain('Recovery Mode Off');
  });

  it('explains that the wallet must be an EOA', () => {
    expect(render()).toMatch(/EOA wallet, not a smart account/);
  });

  it('is candid about redemptions and liquidation', () => {
    const text = render();
    expect(text).toMatch(/redeem it for BTC at face value/);
    expect(text).toMatch(/Below 110% it can be liquidated/);
  });

  it('shows an active trove with what closing takes', () => {
    state.wallet = wallet(
      { status: TROVE_STATUS.ACTIVE, coll: WAD / 10n, debt: 2_702n * WAD, icr: (288n * WAD) / 100n },
      { shares: 2_500n * 10n ** 24n, supplyAssets: 2_500n * WAD, musd: 50n * WAD },
    );
    const text = render();
    expect(text).toContain('Your trove');
    expect(text).toContain('2,702.00 MUSD');
    expect(text).toContain('288.0%');
    expect(text).toContain('Sign and close trove');
    // Debt 2,702, plus the interest margin, less the 200 gas compensation.
    expect(text).toContain('2,502.27 MUSD');
    expect(text).toContain('from your wallet');
  });

  it('names the shortfall when supply and wallet cannot pay for a close', () => {
    state.wallet = wallet(
      { status: TROVE_STATUS.ACTIVE, coll: WAD / 10n, debt: 2_702n * WAD },
      { shares: 1_000n * 10n ** 24n, supplyAssets: 1_000n * WAD, musd: 0n },
    );
    expect(render()).toMatch(/You are 1,502\.27 MUSD short/);
  });

  it('blocks a close in Recovery Mode, but not a repayment', () => {
    state.wallet = wallet(
      { status: TROVE_STATUS.ACTIVE, coll: WAD / 10n, debt: 2_702n * WAD, recoveryMode: true },
      { shares: 3_000n * 10n ** 24n, supplyAssets: 3_000n * WAD },
    );
    const text = render();
    expect(text).toMatch(/Recovery Mode, when troves cannot be closed/);
    expect(text).toContain('Sign and repay');
  });

  it('offers BTC left from a redeemed trove', () => {
    state.wallet = wallet({ status: TROVE_STATUS.CLOSED_BY_REDEMPTION, surplus: WAD / 100n });
    const text = render();
    expect(text).toContain('0.0100 BTC is left');
    expect(text).toContain('Claim BTC');
    expect(text).toContain('Your last trove was redeemed in full');
  });
});
