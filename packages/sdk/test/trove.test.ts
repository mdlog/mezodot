import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverTypedDataAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  GAS_COMPENSATION,
  MIN_NET_DEBT,
  closeFunding,
  closeTroveTypedData,
  findTroveHints,
  maxTroveRepay,
  openBlockers,
  openTroveTypedData,
  previewOpenTrove,
  repayTroveTypedData,
  readTrove,
  SOURCE_TAG,
  TROVE_STATUS,
  type HubDeployment,
} from '../src';

const WAD = 10n ** 18n;
const SIGNATURES = '0xD757e3646AF370b15f32EB557F0F8380Df7D639e' as Address;
const account = privateKeyToAccount('0x00000000000000000000000000000000000000000000000000000000000a11ce');
const ROUTER = '0x00000000000000000000000000000000000000aa' as Address;

describe('oracle source tags', () => {
  it('names the keyless Skip and Tigris TWAP sources as registered on the router', () => {
    expect(SOURCE_TAG.SKIP).toBe(3);
    expect(SOURCE_TAG.TWAP).toBe(4);
  });
});

describe('trove signatures', () => {
  const domain = { signatures: SIGNATURES, chainId: 31611 };

  it('open signs the exact type and domain Mezo checks', async () => {
    const typed = openTroveTypedData(domain, {
      assetAmount: WAD,
      debtAmount: 2_500n * WAD,
      borrower: account.address,
      recipient: ROUTER,
      nonce: 7n,
      deadline: 99n,
    });
    expect(typed.domain).toEqual({ name: 'BorrowerOperationsSignatures', version: '1', chainId: 31611, verifyingContract: SIGNATURES });
    expect(typed.primaryType).toBe('OpenTrove');
    // keccak256 of the type string is what TroveRouter's fork test signs against the live contract.
    expect(typed.types.OpenTrove.map((f) => `${f.type} ${f.name}`).join(',')).toBe(
      'uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline',
    );
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
  });

  it('repay and close bind what the live contract binds', () => {
    const repay = repayTroveTypedData(domain, { amount: WAD, borrower: account.address, nonce: 1n, deadline: 2n });
    expect(repay.types.RepayMUSD.map((f) => f.name)).toEqual(['amount', 'borrower', 'nonce', 'deadline']);
    const close = closeTroveTypedData(domain, { borrower: account.address, recipient: account.address, nonce: 1n, deadline: 2n });
    expect(close.types.CloseTrove.map((f) => f.name)).toEqual(['borrower', 'recipient', 'nonce', 'deadline']);
    expect(hashTypedData(repay)).not.toBe(hashTypedData(close));
  });
});

describe('previewOpenTrove', () => {
  const rate = WAD / 1000n; // 0.1%
  const price = 78_000n * WAD;

  it('adds the fee and the gas compensation to the trove debt', () => {
    const p = previewOpenTrove({ btc: WAD / 10n, debtAmount: 2_500n * WAD, price, borrowingRate: rate, recoveryMode: false });
    expect(p.fee).toBe((2_500n * WAD) / 1000n);
    expect(p.netDebt).toBe(2_502n * WAD + WAD / 2n);
    expect(p.totalDebt).toBe(p.netDebt + GAS_COMPENSATION);
  });

  it('charges no fee in Recovery Mode', () => {
    const p = previewOpenTrove({ btc: WAD / 10n, debtAmount: 2_500n * WAD, price, borrowingRate: rate, recoveryMode: true });
    expect(p.fee).toBe(0n);
    expect(p.totalDebt).toBe(2_700n * WAD);
  });

  it('computes the collateral ratio, capacity and the price that makes the trove liquidatable', () => {
    const p = previewOpenTrove({ btc: WAD / 10n, debtAmount: 2_500n * WAD, price, borrowingRate: 0n, recoveryMode: false });
    expect(p.icr).toBe(((WAD / 10n) * price) / p.totalDebt);
    expect(p.maxBorrowingCapacity).toBe(((WAD / 10n) * price * 10n) / (11n * WAD));
    // At the liquidation price the ratio is exactly the 110% minimum.
    expect((p.liquidationPrice * (WAD / 10n)) / p.totalDebt).toBeGreaterThanOrEqual((11n * WAD) / 10n - 10n);
    expect((p.liquidationPrice * (WAD / 10n)) / p.totalDebt).toBeLessThanOrEqual((11n * WAD) / 10n);
  });
});

describe('openBlockers', () => {
  const base = {
    btc: WAD / 10n,
    debtAmount: 2_500n * WAD,
    price: 78_000n * WAD,
    borrowingRate: WAD / 1000n,
    recoveryMode: false,
    systemColl: 1_000n * WAD,
    systemDebt: 10_000_000n * WAD,
    status: TROVE_STATUS.NONE as number,
    isContract: false,
  };

  it('accepts a healthy trove', () => {
    expect(openBlockers(base)).toEqual([]);
  });

  it('refuses a smart account: Mezo checks plain ECDSA signatures only', () => {
    expect(openBlockers({ ...base, isContract: true }).join()).toMatch(/smart account/i);
  });

  it('refuses a second trove', () => {
    expect(openBlockers({ ...base, status: TROVE_STATUS.ACTIVE }).join()).toMatch(/already/i);
  });

  it('refuses debt under the minimum net debt', () => {
    const debtAmount = MIN_NET_DEBT - 10n * WAD;
    expect(openBlockers({ ...base, debtAmount }).join()).toMatch(/1,800/);
  });

  it('refuses a ratio under 110%', () => {
    expect(openBlockers({ ...base, btc: WAD / 30n }).join()).toMatch(/110%/);
  });

  it('refuses a ratio under 150% in Recovery Mode', () => {
    expect(openBlockers({ ...base, btc: (WAD * 5n) / 100n, recoveryMode: true }).join()).toMatch(/Recovery Mode/);
  });

  it('refuses when the system ratio after opening falls below 150%', () => {
    const tight = { ...base, systemColl: WAD, systemDebt: 52_000n * WAD, btc: WAD / 20n, debtAmount: 3_000n * WAD };
    expect(openBlockers(tight).join()).toMatch(/system/i);
  });
});

describe('repay and close limits', () => {
  it('leaves the minimum net debt after a repayment', () => {
    expect(maxTroveRepay(2_702n * WAD)).toBe(702n * WAD);
    expect(maxTroveRepay(GAS_COMPENSATION + MIN_NET_DEBT)).toBe(0n);
    expect(maxTroveRepay(1_000n * WAD)).toBe(0n);
  });

  it('funds a close from supply first, then the wallet, and names any shortfall', () => {
    // Closing burns debt minus the 200 MUSD gas compensation.
    expect(closeFunding({ debt: 2_702n * WAD, supplyAssets: 2_500n * WAD, walletMusd: 10n * WAD })).toEqual({
      needed: 2_502n * WAD,
      fromSupply: 2_500n * WAD,
      fromWallet: 2n * WAD,
      shortfall: 0n,
    });
    expect(closeFunding({ debt: 2_702n * WAD, supplyAssets: 2_600n * WAD, walletMusd: 0n })).toEqual({
      needed: 2_502n * WAD,
      fromSupply: 2_502n * WAD,
      fromWallet: 0n,
      shortfall: 0n,
    });
    expect(closeFunding({ debt: 2_702n * WAD, supplyAssets: 2_000n * WAD, walletMusd: 100n * WAD })).toEqual({
      needed: 2_502n * WAD,
      fromSupply: 2_000n * WAD,
      fromWallet: 100n * WAD,
      shortfall: 402n * WAD,
    });
  });
});

describe('chain reads', () => {
  const contracts = {
    mezoBorrowerOperations: '0x0000000000000000000000000000000000000001',
    mezoBorrowerSignatures: SIGNATURES,
    mezoTroveManager: '0x0000000000000000000000000000000000000002',
    mezoHintHelpers: '0x0000000000000000000000000000000000000003',
    mezoSortedTroves: '0x0000000000000000000000000000000000000004',
    mezoPriceFeed: '0x0000000000000000000000000000000000000005',
    mezoCollSurplusPool: '0x0000000000000000000000000000000000000006',
    troveRouter: ROUTER,
  } as unknown as HubDeployment['contracts'];
  const hub = { contracts } as HubDeployment;

  it('asks Mezo for an insert position at the nominal ratio (coll x 1e20 / debt)', async () => {
    const calls: { functionName: string; args: readonly unknown[] }[] = [];
    const client = {
      readContract: async (c: { functionName: string; args: readonly unknown[] }) => {
        calls.push(c);
        if (c.functionName === 'getApproxHint') return ['0x00000000000000000000000000000000000000b1', 0n, 0n];
        return ['0x00000000000000000000000000000000000000c1', '0x00000000000000000000000000000000000000c2'];
      },
    } as unknown as PublicClient;
    const hints = await findTroveHints(client, hub, WAD, 2_000n * WAD);
    expect(hints).toEqual({ upper: '0x00000000000000000000000000000000000000c1', lower: '0x00000000000000000000000000000000000000c2' });
    const nicr = (WAD * 10n ** 20n) / (2_000n * WAD);
    expect(calls[0].functionName).toBe('getApproxHint');
    expect(calls[0].args[0]).toBe(nicr);
    expect(calls[1].args).toEqual([nicr, '0x00000000000000000000000000000000000000b1', '0x00000000000000000000000000000000000000b1']);
  });

  it('reads total debt as principal plus interest: pending amounts are already folded in', async () => {
    const results: Record<string, unknown> = {
      fetchPrice: 78_000n * WAD,
      getTCR: 2n * WAD,
      checkRecoveryMode: false,
      borrowingRate: WAD / 1000n,
      redemptionRate: (WAD * 75n) / 10_000n,
      getEntireSystemColl: 100n * WAD,
      getEntireSystemDebt: 1_000_000n * WAD,
      getTroveStatus: TROVE_STATUS.ACTIVE,
      // coll, principal, interest, pendingColl, pendingPrincipal, pendingInterest
      getEntireDebtAndColl: [WAD / 10n, 2_700n * WAD, 2n * WAD, 5n, 6n, 7n],
      getTroveMaxBorrowingCapacity: 7_000n * WAD,
      getCollateral: 0n,
      getNonce: 3n,
    };
    const client = {
      readContract: async (c: { functionName: string }) => results[c.functionName],
      getCode: async () => undefined,
    } as unknown as PublicClient;
    const t = await readTrove(client, hub, account.address);
    expect(t.debt).toBe(2_702n * WAD);
    expect(t.coll).toBe(WAD / 10n);
    expect(t.icr).toBe(((WAD / 10n) * 78_000n * WAD) / (2_702n * WAD));
    expect(t.status).toBe(TROVE_STATUS.ACTIVE);
    expect(t.isContract).toBe(false);
    expect(t.nonce).toBe(3n);
  });

  it('reports a smart account from its code, and no ratio without debt', async () => {
    const results: Record<string, unknown> = {
      fetchPrice: 78_000n * WAD,
      getTCR: 2n * WAD,
      checkRecoveryMode: true,
      borrowingRate: 0n,
      redemptionRate: 0n,
      getEntireSystemColl: 0n,
      getEntireSystemDebt: 0n,
      getTroveStatus: TROVE_STATUS.NONE,
      getEntireDebtAndColl: [0n, 0n, 0n, 0n, 0n, 0n],
      getTroveMaxBorrowingCapacity: 0n,
      getCollateral: WAD,
      getNonce: 0n,
    };
    const client = {
      readContract: async (c: { functionName: string }) => results[c.functionName],
      getCode: async () => '0x60',
    } as unknown as PublicClient;
    const t = await readTrove(client, hub, zeroAddress);
    expect(t.isContract).toBe(true);
    expect(t.icr).toBe(0n);
    expect(t.recoveryMode).toBe(true);
    expect(t.surplus).toBe(WAD);
  });
});
