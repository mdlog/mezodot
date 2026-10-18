import { erc20Abi, maxUint256, parseUnits, type Address, type Hex, type PublicClient } from 'viem';
import {
  fetchOracleUpdate,
  keeperGatewayAbi,
  leverageManagerAbi,
  oracleRouterAbi,
  pTokenAbi,
  readOracle,
  riskCheckSymbols,
  spokeGatewayAbi,
  staleSymbols,
  symbolForPriceKey,
  toBytes32,
  vaultManagerAbi,
  wormholeAdapterAbi,
  type CollateralState,
  type MarketState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '@mezodot/sdk';
import { AGENT_URL, HUB, type SpokeInfo } from './env';
import { wethAbi, wrapNeeded } from '../lib/wrap';
import type { TxStep } from './tx';

/**
 * Builders for every user action. Each returns the ordered wallet steps; approvals are skipped
 * when the allowance already covers the amount. Risk-checked calls attach the pull updates their
 * risk check needs (a Supra proof for ETH/USDC from the agent relay; nothing for Pyth feeds Mezo
 * keeps fresh) and pay the oracle fee, plus the Wormhole fee where a message is published.
 */

type Ctx = { account: Address; hub: PublicClient; protocol: ProtocolState; position: PositionState | null };

const hubId = HUB.chain.id;
const d = () => {
  if (!HUB.deployment) throw new Error('Hub contracts are not deployed on this network');
  return HUB.deployment;
};

/**
 * Pull updates for the `symbols` a risk check reads that would not stay valid until the transaction
 * lands, plus the BTC fee the router charges to post them. Built just in time, right before signing.
 */
export async function priceUpdate(hub: PublicClient, symbols: PriceSymbol[]): Promise<{ updates: Hex[]; fee: bigint }> {
  if (symbols.length === 0) return { updates: [], fee: 0n };
  const oracle = await readOracle(hub, d());
  const needed = staleSymbols(oracle, symbols, Math.floor(Date.now() / 1000));
  if (needed.length === 0) return { updates: [], fee: 0n };
  let updates: Hex[];
  try {
    ({ updates } = await fetchOracleUpdate(AGENT_URL, needed));
  } catch (err) {
    throw new Error(`Could not fetch ${needed.join('/')} price updates from the Mezodot agent: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Symbols the relay cannot refresh (Pyth push feeds) go without an update: if they are stale the
  // contract reverts with PriceUnavailable, which explainError reports by name.
  if (updates.length === 0) return { updates, fee: 0n };
  const fee = await hub.readContract({ address: d().contracts.oracleRouter, abi: oracleRouterAbi, functionName: 'updateFee', args: [updates] });
  return { updates, fee };
}

const marketSymbol = (m: MarketState) => symbolForPriceKey(m.priceKey);

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
  {
    label: `Post ${c.symbol} as collateral`,
    chainId: hubId,
    request: async () => ({ address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'depositCollateral', args: [BigInt(c.id), shares] }),
  },
];

export const withdrawCollateralSteps = ({ account, hub, protocol, position }: Ctx, c: CollateralState, shares: bigint): TxStep[] => [
  {
    label: `Withdraw ${c.symbol} collateral`,
    chainId: hubId,
    request: async () => {
      const { updates, fee } = await priceUpdate(hub, riskCheckSymbols(protocol, position));
      return {
        address: d().contracts.vaultManager,
        abi: vaultManagerAbi,
        functionName: 'withdrawCollateral',
        args: [BigInt(c.id), shares, account, updates],
        value: fee,
      };
    },
  },
];

// --- Borrow / repay --------------------------------------------------------------

export const borrowSteps = ({ hub, protocol, position }: Ctx, m: MarketState, amount: bigint): TxStep[] => [
  {
    label: `Borrow ${m.symbol}`,
    chainId: hubId,
    request: async () => {
      const { updates, fee } = await priceUpdate(hub, riskCheckSymbols(protocol, position, marketSymbol(m)));
      return { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'borrow', args: [BigInt(m.id), amount, updates], value: fee };
    },
  },
];

/** `all` repays the whole (accruing) debt: approve with a small buffer and pass uint max. */
export const repaySteps = ({ account, hub }: Ctx, m: MarketState, amount: bigint, all: boolean): TxStep[] => {
  const approveAmount = all ? amount + amount / 1_000n + 1n : amount;
  return [
    approveStep(hub, hubId, m.asset, account, d().contracts.vaultManager, approveAmount, `Approve ${m.symbol}`),
    {
      label: `Repay ${m.symbol}`,
      chainId: hubId,
      request: async () => ({
        address: d().contracts.vaultManager,
        abi: vaultManagerAbi,
        functionName: 'repay',
        args: [BigInt(m.id), all ? maxUint256 : amount, account],
      }),
    },
  ];
};

// --- Cross-chain ------------------------------------------------------------------

/**
 * Lock `amount` of `token` on a spoke. With `wrapNative`, WETH missing from the wallet is first wrapped
 * from native ETH (SpokeGateway only accepts ERC-20s); the shortfall is read just before signing.
 */
export const spokeDepositSteps = (
  account: Address,
  spoke: SpokeInfo,
  client: PublicClient,
  token: Address,
  symbol: string,
  amount: bigint,
  opts: { wrapNative?: boolean } = {},
): TxStep[] => {
  if (!spoke.deployment) throw new Error(`${spoke.label} gateway is not deployed`);
  const gateway = spoke.deployment.contracts.spokeGateway;
  const wrap: TxStep[] = opts.wrapNative
    ? [
        {
          label: `Wrap ETH → WETH on ${spoke.label}`,
          chainId: spoke.chain.id,
          request: async () => {
            const held = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
            const value = wrapNeeded(held, amount);
            return value === 0n ? null : { address: token, abi: wethAbi, functionName: 'deposit', value };
          },
        },
      ]
    : [];
  return [
    ...wrap,
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

export const withdrawRemoteSteps = ({ account, hub, protocol, position }: Ctx, c: CollateralState, amount: bigint, recipient: Address = account): TxStep[] => [
  {
    label: `Release ${c.symbol} on spoke`,
    chainId: hubId,
    request: async () => {
      const [{ updates, fee }, wormholeFee] = await Promise.all([
        priceUpdate(hub, riskCheckSymbols(protocol, position)),
        hub.readContract({ address: d().contracts.wormholeAdapter, abi: wormholeAdapterAbi, functionName: 'messageFee' }),
      ]);
      return {
        address: d().contracts.vaultManager,
        abi: vaultManagerAbi,
        functionName: 'withdrawRemote',
        args: [BigInt(c.id), amount, toBytes32(recipient), updates],
        value: fee + wormholeFee,
      };
    },
  },
];

/** Permissionless self-relay: anyone can deliver a signed VAA. */
export const relayHubSteps = (vaa: Hex): TxStep[] => [
  {
    label: 'Deliver message to Mezo',
    chainId: hubId,
    request: async () => ({ address: d().contracts.keeperGateway, abi: keeperGatewayAbi, functionName: 'relayMessage', args: [vaa] }),
  },
];

export const relaySpokeSteps = (spoke: SpokeInfo, vaa: Hex): TxStep[] => [
  {
    label: `Deliver release to ${spoke.label}`,
    chainId: spoke.chain.id,
    request: async () => ({ address: spoke.deployment!.contracts.spokeGateway, abi: spokeGatewayAbi, functionName: 'receiveMessage', args: [vaa] }),
  },
];

// --- Loop ----------------------------------------------------------------------------

export const loopSteps = ({ account, hub, protocol, position }: Ctx, musd: MarketState, principal: bigint, leverage: number, isOperator: boolean): TxStep[] => {
  const lm = d().contracts.leverageManager;
  const leverageWad = parseUnits(leverage.toString(), 18);
  return [
    {
      label: 'Authorise LeverageManager',
      chainId: hubId,
      request: async () => (isOperator ? null : { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'setOperator', args: [lm, true] }),
    },
    approveStep(hub, hubId, musd.asset, account, lm, principal, 'Approve MUSD'),
    {
      label: `Open ${leverage}× loop`,
      chainId: hubId,
      request: async () => {
        const gross = (principal * leverageWad) / 10n ** 18n;
        const expectedShares = await hub.readContract({ address: musd.pool, abi: pTokenAbi, functionName: 'previewDeposit', args: [gross] });
        const { updates, fee } = await priceUpdate(hub, riskCheckSymbols(protocol, position, marketSymbol(musd)));
        return {
          address: lm,
          abi: leverageManagerAbi,
          functionName: 'loop',
          args: [principal, leverageWad, (expectedShares * 995n) / 1000n, updates],
          value: fee,
        };
      },
    },
  ];
};

export const unwindSteps = ({ hub, protocol, position }: Ctx, minOut: bigint): TxStep[] => [
  {
    label: 'Unwind loop',
    chainId: hubId,
    request: async () => {
      const { updates, fee } = await priceUpdate(hub, riskCheckSymbols(protocol, position));
      return {
        address: d().contracts.leverageManager,
        abi: leverageManagerAbi,
        functionName: 'unwind',
        args: [maxUint256, maxUint256, minOut, updates],
        value: fee,
      };
    },
  },
];
