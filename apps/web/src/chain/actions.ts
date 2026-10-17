import { erc20Abi, maxUint256, parseUnits, type Address, type Hex, type PublicClient } from 'viem';
import {
  fetchPriceUpdate,
  keeperGatewayAbi,
  leverageManagerAbi,
  oracleRouterAbi,
  pTokenAbi,
  spokeGatewayAbi,
  toBytes32,
  vaultManagerAbi,
  wormholeAdapterAbi,
  type CollateralState,
  type MarketState,
} from '@mezodot/sdk';
import { HUB, type SpokeInfo } from './env';
import type { TxStep } from './tx';

/**
 * Builders for every user action. Each returns the ordered wallet steps; approvals are skipped
 * when the allowance already covers the amount. Risk-checked calls carry fresh Pyth updates and
 * pay the oracle fee (plus the Wormhole fee where a message is published).
 */

type Ctx = { account: Address; hub: PublicClient };

const hubId = HUB.chain.id;
const d = () => {
  if (!HUB.deployment) throw new Error('Hub contracts are not deployed on this network');
  return HUB.deployment;
};

/** Fresh signed prices + the BTC fee the oracle charges to post them. */
export async function priceUpdate(hub: PublicClient): Promise<{ updates: Hex[]; fee: bigint }> {
  const { updates } = await fetchPriceUpdate(HUB.hermesUrl, Object.values(d().priceFeeds) as Hex[]);
  const fee = await hub.readContract({ address: d().contracts.oracleRouter, abi: oracleRouterAbi, functionName: 'updateFee', args: [updates] });
  return { updates, fee };
}

function approveStep(client: PublicClient, chainId: number, token: Address, owner: Address, spender: Address, amount: bigint, label: string): TxStep {
  return {
    label,
    chainId,
    request: async () => {
      const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
      if (allowance >= amount) return null;
      return { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] };
    },
  };
}

export const toUnits = (amount: string, decimals: number) => parseUnits(amount, decimals);

// --- Markets ------------------------------------------------------------------

export const supplySteps = ({ account, hub }: Ctx, m: MarketState, amount: bigint): TxStep[] => [
  approveStep(hub, hubId, m.asset, account, m.pool, amount, `Approve ${m.symbol}`),
  { label: `Supply ${m.symbol}`, chainId: hubId, request: async () => ({ address: m.pool, abi: pTokenAbi, functionName: 'deposit', args: [amount, account] }) },
];

/** Withdraw underlying; `redeemAll` redeems every share (avoids dust from rounding). */
export const withdrawSteps = ({ account }: Ctx, m: MarketState, amount: bigint, redeemAll: { shares: bigint } | null): TxStep[] => [
  {
    label: `Withdraw ${m.symbol}`,
    chainId: hubId,
    request: async () =>
      redeemAll
        ? { address: m.pool, abi: pTokenAbi, functionName: 'redeem', args: [redeemAll.shares, account, account] }
        : { address: m.pool, abi: pTokenAbi, functionName: 'withdraw', args: [amount, account, account] },
  },
];

// --- Collateral -----------------------------------------------------------------

export const postCollateralSteps = ({ account, hub }: Ctx, c: CollateralState, shares: bigint): TxStep[] => [
  approveStep(hub, hubId, c.token, account, d().contracts.vaultManager, shares, `Approve ${c.symbol}`),
  { label: `Post ${c.symbol} as collateral`, chainId: hubId, request: async () => ({ address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'depositCollateral', args: [BigInt(c.id), shares] }) },
];

export const withdrawCollateralSteps = ({ account, hub }: Ctx, c: CollateralState, shares: bigint): TxStep[] => [
  {
    label: `Withdraw ${c.symbol} collateral`,
    chainId: hubId,
    request: async () => {
      const { updates, fee } = await priceUpdate(hub);
      return { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'withdrawCollateral', args: [BigInt(c.id), shares, account, updates], value: fee };
    },
  },
];

// --- Borrow / repay --------------------------------------------------------------

export const borrowSteps = ({ hub }: Ctx, m: MarketState, amount: bigint): TxStep[] => [
  {
    label: `Borrow ${m.symbol}`,
    chainId: hubId,
    request: async () => {
      const { updates, fee } = await priceUpdate(hub);
      return { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'borrow', args: [BigInt(m.id), amount, updates], value: fee };
    },
  },
];

/** `all` repays the whole (accruing) debt: approve with a small buffer and pass uint max. */
export const repaySteps = ({ account, hub }: Ctx, m: MarketState, amount: bigint, all: boolean): TxStep[] => {
  const approveAmount = all ? amount + amount / 1_000n + 1n : amount;
  return [
    approveStep(hub, hubId, m.asset, account, d().contracts.vaultManager, approveAmount, `Approve ${m.symbol}`),
    { label: `Repay ${m.symbol}`, chainId: hubId, request: async () => ({ address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'repay', args: [BigInt(m.id), all ? maxUint256 : amount, account] }) },
  ];
};

// --- Cross-chain ------------------------------------------------------------------

export const spokeDepositSteps = (account: Address, spoke: SpokeInfo, client: PublicClient, token: Address, symbol: string, amount: bigint): TxStep[] => {
  if (!spoke.deployment) throw new Error(`${spoke.label} gateway is not deployed`);
  const gateway = spoke.deployment.contracts.spokeGateway;
  return [
    approveStep(client, spoke.chain.id, token, account, gateway, amount, `Approve ${symbol} on ${spoke.label}`),
    {
      label: `Lock ${symbol} on ${spoke.label}`,
      chainId: spoke.chain.id,
      request: async () => {
        const fee = await client.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'messageFee' });
        return { address: gateway, abi: spokeGatewayAbi, functionName: 'deposit', args: [token, amount], value: fee };
      },
    },
  ];
};

export const withdrawRemoteSteps = ({ account, hub }: Ctx, c: CollateralState, amount: bigint, recipient: Address = account): TxStep[] => [
  {
    label: `Release ${c.symbol} on spoke`,
    chainId: hubId,
    request: async () => {
      const [{ updates, fee }, wormholeFee] = await Promise.all([
        priceUpdate(hub),
        hub.readContract({ address: d().contracts.wormholeAdapter, abi: wormholeAdapterAbi, functionName: 'messageFee' }),
      ]);
      return { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'withdrawRemote', args: [BigInt(c.id), amount, toBytes32(recipient), updates], value: fee + wormholeFee };
    },
  },
];

/** Permissionless self-relay: anyone can deliver a signed VAA. */
export const relayHubSteps = (vaa: Hex): TxStep[] => [
  { label: 'Deliver message to Mezo', chainId: hubId, request: async () => ({ address: d().contracts.keeperGateway, abi: keeperGatewayAbi, functionName: 'relayMessage', args: [vaa] }) },
];

export const relaySpokeSteps = (spoke: SpokeInfo, vaa: Hex): TxStep[] => [
  { label: `Deliver release to ${spoke.label}`, chainId: spoke.chain.id, request: async () => ({ address: spoke.deployment!.contracts.spokeGateway, abi: spokeGatewayAbi, functionName: 'receiveMessage', args: [vaa] }) },
];

// --- Loop ----------------------------------------------------------------------------

export const loopSteps = ({ account, hub }: Ctx, musd: MarketState, principal: bigint, leverage: number, isOperator: boolean): TxStep[] => {
  const lm = d().contracts.leverageManager;
  const leverageWad = parseUnits(leverage.toString(), 18);
  return [
    { label: 'Authorise LeverageManager', chainId: hubId, request: async () => (isOperator ? null : { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'setOperator', args: [lm, true] }) },
    approveStep(hub, hubId, musd.asset, account, lm, principal, 'Approve MUSD'),
    {
      label: `Open ${leverage}× loop`,
      chainId: hubId,
      request: async () => {
        const gross = (principal * leverageWad) / 10n ** 18n;
        const expectedShares = await hub.readContract({ address: musd.pool, abi: pTokenAbi, functionName: 'previewDeposit', args: [gross] });
        const { updates, fee } = await priceUpdate(hub);
        return { address: lm, abi: leverageManagerAbi, functionName: 'loop', args: [principal, leverageWad, (expectedShares * 995n) / 1000n, updates], value: fee };
      },
    },
  ];
};

export const unwindSteps = ({ hub }: Ctx, minOut: bigint): TxStep[] => [
  {
    label: 'Unwind loop',
    chainId: hubId,
    request: async () => {
      const { updates, fee } = await priceUpdate(hub);
      return { address: d().contracts.leverageManager, abi: leverageManagerAbi, functionName: 'unwind', args: [maxUint256, maxUint256, minOut, updates], value: fee };
    },
  },
];
