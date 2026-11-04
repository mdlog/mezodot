import { describe, expect, it } from 'vitest';
import { erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import { GAS_FLOOR, TROVE_STATUS, troveRouterAbi, vaultManagerAbi, type TroveState } from '@mezodot/sdk';
import { HUB } from './env';
import { claimTroveSurplusSteps, closeTroveSteps, openTroveSteps, repayTroveSteps, type TroveSigner } from './trove';
import type { TxRequest, TxStep } from './runner';

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';
const WAD = 10n ** 18n;
const dep = HUB.deployment!;
const ROUTER = dep.contracts.troveRouter!;
const SIGNATURE: Hex = '0xabcdef';

const trove = (patch: Partial<TroveState> = {}): TroveState => ({
  price: 78_000n * WAD,
  tcr: 2n * WAD,
  recoveryMode: false,
  borrowingRate: WAD / 1000n,
  redemptionRate: 0n,
  interestRateBps: 100,
  systemColl: 1_000n * WAD,
  systemDebt: 10_000_000n * WAD,
  status: TROVE_STATUS.NONE,
  coll: 0n,
  debt: 0n,
  icr: 0n,
  maxBorrowingCapacity: 0n,
  surplus: 0n,
  nonce: 4n,
  isContract: false,
  ...patch,
});

/** A hub whose reads answer from `results` by function name, with what each read and sign received. */
function fakes(results: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    isOperator: false,
    allowance: 0n,
    previewDeposit: 2_500n * 10n ** 24n,
    previewWithdraw: 100n * 10n ** 24n,
    getApproxHint: ['0x00000000000000000000000000000000000000b1', 0n, 0n],
    findInsertPosition: ['0x00000000000000000000000000000000000000c1', '0x00000000000000000000000000000000000000c2'],
  };
  const hub = {
    readContract: async ({ functionName }: { functionName: string }) => ({ ...defaults, ...results })[functionName],
  } as unknown as PublicClient;
  const signed: { primaryType: string; message: Record<string, unknown> }[] = [];
  const sign: TroveSigner = async (typed) => {
    signed.push(typed as unknown as { primaryType: string; message: Record<string, unknown> });
    return SIGNATURE;
  };
  return { hub, sign, signed };
}

const build = async (steps: TxStep[]) => Promise.all(steps.map(async (s) => ((await s.request()) as TxRequest | null) ?? null));

describe('openTroveSteps', () => {
  const input = { btc: WAD / 10n, debtAmount: 2_500n * WAD, post: false };

  it('signs for the router as recipient and sends the BTC with the call', async () => {
    const { hub, sign, signed } = fakes();
    const steps = openTroveSteps({ account: ACCOUNT, hub }, input, () => Promise.resolve(trove()), sign);
    expect(steps.map((s) => s.label)).toEqual(['Open trove and supply to pMUSD']);
    expect(steps[0].gasFloor).toBe(GAS_FLOOR.troveOpen);
    const [open] = await build(steps);
    expect(open?.address).toBe(ROUTER);
    expect(open?.abi).toBe(troveRouterAbi);
    expect(open?.functionName).toBe('openAndSupply');
    expect(open?.value).toBe(WAD / 10n);
    expect(signed[0].primaryType).toBe('OpenTrove');
    expect(signed[0].message).toMatchObject({ assetAmount: WAD / 10n, debtAmount: 2_500n * WAD, borrower: ACCOUNT, recipient: ROUTER, nonce: 4n });
    const args = open!.args as readonly unknown[];
    expect(args.slice(0, 4)).toEqual([2_500n * WAD, '0x00000000000000000000000000000000000000c1', '0x00000000000000000000000000000000000000c2', SIGNATURE]);
    // Shares, less half a percent for the exchange rate moving before it lands; not posted.
    expect(args[5]).toBe((2_500n * 10n ** 24n * 9_950n) / 10_000n);
    expect(args[6]).toBe(false);
  });

  it('lets the router post the shares when asked, approving it only once', async () => {
    const first = fakes();
    const steps = openTroveSteps({ account: ACCOUNT, hub: first.hub }, { ...input, post: true }, () => Promise.resolve(trove()), first.sign);
    expect(steps.map((s) => s.label)).toEqual(['Allow the router to post pMUSD', 'Open trove and supply to pMUSD']);
    const [approve, open] = await build(steps);
    expect(approve?.abi).toBe(vaultManagerAbi);
    expect(approve?.functionName).toBe('setOperator');
    expect(approve?.args).toEqual([ROUTER, true]);
    expect((open!.args as readonly unknown[])[6]).toBe(true);

    const again = fakes({ isOperator: true });
    const [skipped] = await build(openTroveSteps({ account: ACCOUNT, hub: again.hub }, { ...input, post: true }, () => Promise.resolve(trove()), again.sign));
    expect(skipped).toBeNull();
  });
});

describe('repayTroveSteps', () => {
  it('approves the shares it may burn, with room for the rate to move', async () => {
    const { hub, sign, signed } = fakes();
    const live = trove({ status: TROVE_STATUS.ACTIVE, coll: WAD / 10n, debt: 2_702n * WAD });
    const [approve, repay] = await build(repayTroveSteps({ account: ACCOUNT, hub }, { amount: 100n * WAD }, () => Promise.resolve(live), sign));
    const maxShares = (100n * 10n ** 24n * 10_050n) / 10_000n;
    expect(approve?.abi).toBe(erc20Abi);
    expect(approve?.args).toEqual([ROUTER, maxShares]);
    expect(repay?.functionName).toBe('repayFromSupply');
    expect(signed[0].primaryType).toBe('RepayMUSD');
    expect(signed[0].message).toMatchObject({ amount: 100n * WAD, borrower: ACCOUNT, nonce: 4n });
    expect((repay!.args as readonly unknown[])[5]).toBe(maxShares);
  });
});

describe('closeTroveSteps', () => {
  it('pays from supply and tops up from the wallet, with BTC returning to the borrower', async () => {
    const { hub, sign, signed } = fakes();
    const live = trove({ status: TROVE_STATUS.ACTIVE, coll: WAD / 10n, debt: 2_702n * WAD });
    const steps = closeTroveSteps({ account: ACCOUNT, hub }, { shares: 2_500n * 10n ** 24n, fromWallet: 3n * WAD }, () => Promise.resolve(live), sign);
    expect(steps.map((s) => s.label)).toEqual(['Approve pMUSD', 'Approve MUSD', 'Close trove']);
    const [shares, musd, close] = await build(steps);
    expect(shares?.args).toEqual([ROUTER, 2_500n * 10n ** 24n]);
    expect(musd?.args).toEqual([ROUTER, 3n * WAD]);
    expect(close?.functionName).toBe('closeFromSupply');
    expect(signed[0].primaryType).toBe('CloseTrove');
    expect(signed[0].message).toMatchObject({ borrower: ACCOUNT, recipient: ACCOUNT });
    expect((close!.args as readonly unknown[]).slice(0, 3)).toEqual([2_500n * 10n ** 24n, 3n * WAD, SIGNATURE]);
  });

  it('asks for no MUSD approval when supply covers the close', () => {
    const { hub, sign } = fakes();
    const steps = closeTroveSteps({ account: ACCOUNT, hub }, { shares: 2n, fromWallet: 0n }, () => Promise.resolve(trove()), sign);
    expect(steps.map((s) => s.label)).toEqual(['Approve pMUSD', 'Close trove']);
  });
});

describe('claimTroveSurplusSteps', () => {
  it('claims directly, with no signature to give', async () => {
    const [claim] = await build(claimTroveSurplusSteps());
    expect(claim?.address).toBe(dep.contracts.mezoBorrowerOperations);
    expect(claim?.functionName).toBe('claimCollateral');
  });
});
