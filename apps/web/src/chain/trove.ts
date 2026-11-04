import { erc20Abi, type Address, type Hex, type PublicClient, type SignTypedDataParameters } from 'viem';
import {
  GAS_FLOOR,
  closeTroveTypedData,
  findTroveHints,
  openTroveTypedData,
  pTokenAbi,
  previewOpenTrove,
  repayTroveTypedData,
  troveBorrowerOperationsAbi,
  troveContracts,
  troveRouterAbi,
  vaultManagerAbi,
  type TroveState,
} from '@mezodot/sdk';
import { HUB } from './env';
import type { TxStep } from './runner';

/**
 * Wallet steps for TroveRouter. Mezo authorises the router by EIP-712 signature, so each trove step asks for a signature
 * first, built just in time from a fresh trove read (the nonce and the hints go stale). Signing moves nothing by itself.
 */

/** The wallet's signTypedData. Typed loosely: each call passes one of the SDK's fully-typed trove messages. */
export type TroveSigner = (typed: Pick<SignTypedDataParameters, 'domain' | 'types' | 'primaryType' | 'message'>) => Promise<Hex>;

type Ctx = { account: Address; hub: PublicClient };
/** Reads the trove again right before signing. */
type FreshTrove = () => Promise<TroveState>;

const hubId = HUB.chain.id;
/** How long a signature stays good: long enough for a slow wallet confirmation, short enough not to linger. */
const DEADLINE_SEC = 1_800n;
/** The pMUSD exchange rate only rises, so this is room for it to move before the transaction lands. */
const SHARE_SLIPPAGE_BPS = 50n;

const deployment = () => {
  if (!HUB.deployment) throw new Error('Hub contracts are not deployed on this network');
  return HUB.deployment;
};
const contracts = () => {
  const c = troveContracts(deployment());
  if (!c) throw new Error('TroveRouter is not deployed on this network');
  return c;
};
const domain = () => ({ signatures: contracts().signatures, chainId: hubId });
const deadline = () => BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SEC;

function approveRouter(hub: PublicClient, account: Address, token: Address, amount: () => Promise<bigint>, label: string): TxStep {
  return {
    label,
    chainId: hubId,
    gasFloor: GAS_FLOOR.erc20Approve,
    request: async () => {
      const needed = await amount();
      const router = contracts().router;
      const allowance = await hub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, router] });
      if (allowance >= needed) return null;
      return { address: token, abi: erc20Abi, functionName: 'approve', args: [router, needed] };
    },
  };
}

export type OpenTroveInput = { btc: bigint; debtAmount: bigint; post: boolean };

export function openTroveSteps({ account, hub }: Ctx, { btc, debtAmount, post }: OpenTroveInput, read: FreshTrove, sign: TroveSigner): TxStep[] {
  const { vaultManager, pMUSD } = deployment().contracts;
  const open: TxStep = {
    label: 'Open trove and supply to pMUSD',
    chainId: hubId,
    gasFloor: GAS_FLOOR.troveOpen,
    request: async () => {
      const t = await read();
      const { totalDebt } = previewOpenTrove({ btc, debtAmount, price: t.price, borrowingRate: t.borrowingRate, recoveryMode: t.recoveryMode });
      const { upper, lower } = await findTroveHints(hub, deployment(), btc, totalDebt);
      const expires = deadline();
      const signature = await sign(
        openTroveTypedData(domain(), { assetAmount: btc, debtAmount, borrower: account, recipient: contracts().router, nonce: t.nonce, deadline: expires }),
      );
      const shares = await hub.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'previewDeposit', args: [debtAmount] });
      const minShares = (shares * (10_000n - SHARE_SLIPPAGE_BPS)) / 10_000n;
      return {
        address: contracts().router,
        abi: troveRouterAbi,
        functionName: 'openAndSupply',
        args: [debtAmount, upper, lower, signature, expires, minShares, post],
        value: btc,
      };
    },
  };
  if (!post) return [open];
  const allow: TxStep = {
    label: 'Allow the router to post pMUSD',
    chainId: hubId,
    request: async () => {
      const router = contracts().router;
      const allowed = await hub.readContract({ address: vaultManager, abi: vaultManagerAbi, functionName: 'isOperator', args: [account, router] });
      return allowed ? null : { address: vaultManager, abi: vaultManagerAbi, functionName: 'setOperator', args: [router, true] };
    },
  };
  return [allow, open];
}

export function repayTroveSteps({ account, hub }: Ctx, { amount }: { amount: bigint }, read: FreshTrove, sign: TroveSigner): TxStep[] {
  const { pMUSD } = deployment().contracts;
  const maxShares = async () => {
    const shares = await hub.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'previewWithdraw', args: [amount] });
    return (shares * (10_000n + SHARE_SLIPPAGE_BPS)) / 10_000n;
  };
  return [
    approveRouter(hub, account, pMUSD, maxShares, 'Approve pMUSD'),
    {
      label: 'Repay trove from supply',
      chainId: hubId,
      gasFloor: GAS_FLOOR.troveAdjust,
      request: async () => {
        const t = await read();
        const { upper, lower } = await findTroveHints(hub, deployment(), t.coll, t.debt - amount);
        const expires = deadline();
        const signature = await sign(repayTroveTypedData(domain(), { amount, borrower: account, nonce: t.nonce, deadline: expires }));
        return {
          address: contracts().router,
          abi: troveRouterAbi,
          functionName: 'repayFromSupply',
          args: [amount, upper, lower, signature, expires, await maxShares()],
        };
      },
    },
  ];
}

/** `shares` are redeemed and `fromWallet` MUSD pulled; whatever the close does not burn comes back to the wallet as MUSD. */
export function closeTroveSteps(
  { account, hub }: Ctx,
  { shares, fromWallet }: { shares: bigint; fromWallet: bigint },
  read: FreshTrove,
  sign: TroveSigner,
): TxStep[] {
  const { pMUSD } = deployment().contracts;
  const { MUSD } = deployment().tokens;
  const close: TxStep = {
    label: 'Close trove',
    chainId: hubId,
    gasFloor: GAS_FLOOR.troveAdjust,
    request: async () => {
      const t = await read();
      const expires = deadline();
      const signature = await sign(closeTroveTypedData(domain(), { borrower: account, recipient: account, nonce: t.nonce, deadline: expires }));
      return { address: contracts().router, abi: troveRouterAbi, functionName: 'closeFromSupply', args: [shares, fromWallet, signature, expires] };
    },
  };
  return [
    ...(shares > 0n ? [approveRouter(hub, account, pMUSD, () => Promise.resolve(shares), 'Approve pMUSD')] : []),
    ...(fromWallet > 0n ? [approveRouter(hub, account, MUSD, () => Promise.resolve(fromWallet), 'Approve MUSD')] : []),
    close,
  ];
}

/** BTC left after a redemption or a capped liquidation. Mezo pays it to the caller, so no signature is involved. */
export const claimTroveSurplusSteps = (): TxStep[] => [
  {
    label: 'Claim BTC surplus',
    chainId: hubId,
    request: async () => ({ address: contracts().borrowerOperations, abi: troveBorrowerOperationsAbi, functionName: 'claimCollateral' }),
  },
];
