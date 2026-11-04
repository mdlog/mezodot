import { describe, expect, it } from 'vitest';
import { TROVE_STATUS, closeBlockedReason as closeBlocked, type TroveState } from '@mezodot/sdk';
import { closePlan } from './trove';

const WAD = 10n ** 18n;
const SHARE = 10n ** 24n;

describe('closePlan', () => {
  const debt = 2_702n * WAD;
  // Closing burns debt minus the 200 MUSD gas compensation, plus a margin for interest accruing until it lands.
  const needed = debt + debt / 10_000n - 200n * WAD;

  it('spends every share and tops up from the wallet when supply falls short', () => {
    const plan = closePlan({ debt, shares: 2_500n * SHARE, supplyAssets: 2_500n * WAD, walletMusd: 50n * WAD });
    expect(plan.shares).toBe(2_500n * SHARE);
    expect(plan.fromWallet).toBe(needed - 2_500n * WAD);
    expect(plan.shortfall).toBe(0n);
  });

  it('spends only the shares it needs when supply is ample, rounded up', () => {
    const plan = closePlan({ debt, shares: 3_000n * SHARE, supplyAssets: 3_000n * WAD, walletMusd: 0n });
    expect(plan.fromWallet).toBe(0n);
    expect(plan.shares * WAD).toBeGreaterThanOrEqual(needed * SHARE);
    expect(plan.shares).toBeLessThan(3_000n * SHARE);
  });

  it('names what is missing', () => {
    const plan = closePlan({ debt, shares: 2_000n * SHARE, supplyAssets: 2_000n * WAD, walletMusd: 100n * WAD });
    expect(plan.shortfall).toBe(needed - 2_100n * WAD);
  });

  it('asks for no shares when there are none', () => {
    expect(closePlan({ debt, shares: 0n, supplyAssets: 0n, walletMusd: 3_000n * WAD })).toMatchObject({ shares: 0n, fromWallet: needed, shortfall: 0n });
  });
});

describe('closeBlocked', () => {
  const trove = (patch: Partial<TroveState>): TroveState => ({
    price: 78_000n * WAD,
    tcr: 2n * WAD,
    recoveryMode: false,
    borrowingRate: 0n,
    redemptionRate: 0n,
    interestRateBps: 100,
    systemColl: 1_000n * WAD,
    systemDebt: 10_000_000n * WAD,
    status: TROVE_STATUS.ACTIVE,
    coll: WAD / 10n,
    debt: 2_702n * WAD,
    icr: 0n,
    maxBorrowingCapacity: 0n,
    surplus: 0n,
    nonce: 0n,
    isContract: false,
    ...patch,
  });

  it('allows a close that leaves the system healthy', () => {
    expect(closeBlocked(trove({}))).toBeNull();
  });

  it('refuses in Recovery Mode', () => {
    expect(closeBlocked(trove({ recoveryMode: true }))).toMatch(/Recovery Mode/);
  });

  it('refuses when the rest of the system would fall below 150%', () => {
    expect(closeBlocked(trove({ systemColl: 100n * WAD, systemDebt: 5_200_000n * WAD, coll: 10n * WAD, debt: 2_702n * WAD }))).toMatch(/150%/);
  });
});
