import { erc20Abi, maxUint256, parseUnits, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import {
  GAS_FLOOR,
  fetchOracleUpdate,
  keeperGatewayAbi,
  leverageManagerAbi,
  oracleRouterAbi,
  PRICE_SYMBOLS,
  pTokenAbi,
  readOracle,
  riskCheckSymbols,
  spokeGatewayAbi,
  staleSymbols,
  swapLeverageManagerAbi,
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
import { lockBlocked, readSpokeLockState } from '../data/guards';
import { markPriceUpdates, type TxStep } from './runner';

/**
 * Builders for every user action. Each returns the ordered wallet steps; approvals are skipped
 * when the allowance already covers the amount. Risk-checked calls attach the pull updates their
 * risk check needs (a Supra proof for ETH/USDC/BTC from the agent relay; nothing for the Pyth-only
 * MUSD/MEZO feeds Mezo keeps fresh) and pay the oracle fee, plus the Wormhole fee where a message is published.
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
 *
 * If the agent relay is unreachable the call goes ahead without updates: many exits need no fresh price
 * (a full unwind, or a withdrawal the other collateral covers, since VaultManager counts an unpriced
 * collateral as zero). The gas estimate decides, and the runner names the relay failure if it reverts.
 */
export async function priceUpdate(hub: PublicClient, symbols: PriceSymbol[]): Promise<{ updates: Hex[]; fee: bigint }> {
  if (symbols.length === 0) return { updates: markPriceUpdates([]), fee: 0n };
  const oracle = await readOracle(hub, d());
  const needed = staleSymbols(oracle, symbols, Math.floor(Date.now() / 1000));
  if (needed.length === 0) return { updates: markPriceUpdates([]), fee: 0n };
  let updates: Hex[];
  try {
    ({ updates } = await fetchOracleUpdate(AGENT_URL, needed));
  } catch (err) {
    const reason = `the Mezodot agent did not return ${needed.join('/')} prices: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    return { updates: markPriceUpdates([], reason), fee: 0n };
  }
  // Symbols the relay cannot refresh (Pyth push feeds) go without an update: if they are stale the
  // contract reverts with PriceUnavailable, which explainError reports by name.
  if (updates.length === 0) return { updates: markPriceUpdates(updates), fee: 0n };
  const fee = await hub.readContract({ address: d().contracts.oracleRouter, abi: oracleRouterAbi, functionName: 'updateFee', args: [updates] });
  return { updates: markPriceUpdates(updates), fee };
}

const marketSymbol = (m: MarketState) => symbolForPriceKey(m.priceKey);

function approveStep(client: PublicClient, chainId: number, token: Address, owner: Address, spender: Address, amount: bigint, label: string): TxStep {
  return {
    label,
    chainId,
    gasFloor: GAS_FLOOR.erc20Approve,
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
  {
    label: `Supply ${m.symbol}`,
    chainId: hubId,
    gasFloor: GAS_FLOOR.poolRedeem,
    request: async () => ({ address: m.pool, abi: pTokenAbi, functionName: 'deposit', args: [amount, account] }),
  },
];

/** Withdraw underlying; `redeemAll` redeems every share (avoids dust from rounding). */
export const withdrawSteps = ({ account }: Ctx, m: MarketState, amount: bigint, redeemAll: { shares: bigint } | null): TxStep[] => [
  {
    label: `Withdraw ${m.symbol}`,
    chainId: hubId,
    gasFloor: GAS_FLOOR.poolRedeem,
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

/** VaultManager.repayWithCollateral exists from the v4 hub on; offered only when the ABI has it. */
export const REPAY_WITH_COLLATERAL = (vaultManagerAbi as Abi).some((x) => x.type === 'function' && x.name === 'repayWithCollateral');

/**
 * Repays `m` debt by burning posted shares of the same pool (pMUSD against MUSD debt), like Aave's
 * repayWithATokens: no tokens move and no price is needed. `amount` = maxUint256 repays all it can.
 */
export const repayWithCollateralSteps = ({ account }: Ctx, m: MarketState, c: CollateralState, amount: bigint): TxStep[] => [
  {
    label: `Repay ${m.symbol} with ${c.symbol}`,
    chainId: hubId,
    request: async () => {
      if (!REPAY_WITH_COLLATERAL) throw new Error('Repaying with collateral is not available on this hub deployment');
      return {
        address: d().contracts.vaultManager,
        abi: vaultManagerAbi as Abi,
        functionName: 'repayWithCollateral',
        args: [account, BigInt(m.id), BigInt(c.id), amount],
      };
    },
  },
];

// --- Cross-chain ------------------------------------------------------------------

/**
 * Lock `amount` of `token` on a spoke. With `wrapNative`, WETH missing from the wallet is first wrapped
 * from native ETH (SpokeGateway only accepts ERC-20s); the shortfall is read just before signing.
 *
 * Before the first transaction the gateway and the hub are checked: a paused gateway, a cap or an unknown
 * token would only revert at the lock (after wrap and approve were paid for), and a lock the hub does not
 * recognise yields a message it rejects, which the spoke cannot refund.
 */
export const spokeDepositSteps = (
  account: Address,
  spoke: SpokeInfo,
  clients: { spoke: PublicClient; hub: PublicClient },
  token: Address,
  symbol: string,
  amount: bigint,
  opts: { wrapNative?: boolean } = {},
): TxStep[] => {
  if (!spoke.deployment) throw new Error(`${spoke.label} gateway is not deployed`);
  const client = clients.spoke;
  const gateway = spoke.deployment.contracts.spokeGateway;
  const preflight = async () => {
    const reason = lockBlocked(await readSpokeLockState(spoke, client, clients.hub, token), spoke.label, symbol, amount);
    if (reason) throw new Error(reason);
  };
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
  const [first, ...rest]: TxStep[] = [
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
  return [
    {
      ...first,
      request: async () => {
        await preflight();
        return first.request();
      },
    },
    ...rest,
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
    gasFloor: GAS_FLOOR.vaaRelay,
    request: async () => ({ address: d().contracts.keeperGateway, abi: keeperGatewayAbi, functionName: 'relayMessage', args: [vaa] }),
  },
];

export const relaySpokeSteps = (spoke: SpokeInfo, vaa: Hex): TxStep[] => {
  if (!spoke.deployment) throw new Error(`${spoke.label} gateway is not deployed`);
  const gateway = spoke.deployment.contracts.spokeGateway;
  return [
    {
      label: `Deliver release to ${spoke.label}`,
      chainId: spoke.chain.id,
      gasFloor: GAS_FLOOR.vaaRelay,
      request: async () => ({ address: gateway, abi: spokeGatewayAbi, functionName: 'receiveMessage', args: [vaa] }),
    },
  ];
};

/**
 * Collects a release whose transfer failed on delivery (SpokeGateway kept it as claimable for the connected
 * account) and sends it to `to`. The amount is read just before signing: nothing left means nothing to send.
 */
export const claimSteps = (account: Address, spoke: SpokeInfo, client: PublicClient, token: Address, symbol: string, to: Address = account): TxStep[] => {
  if (!spoke.deployment) throw new Error(`${spoke.label} gateway is not deployed`);
  const gateway = spoke.deployment.contracts.spokeGateway;
  return [
    {
      label: `Claim ${symbol} on ${spoke.label}`,
      chainId: spoke.chain.id,
      request: async () => {
        const amount = await client.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'claimable', args: [account, token] });
        return amount === 0n ? null : { address: gateway, abi: spokeGatewayAbi, functionName: 'claim', args: [token, to] };
      },
    },
  ];
};

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

/**
 * Unwinds the MUSD loop: LeverageManager nets the MUSD debt against the posted pMUSD inside the pool (no flash loan,
 * no fee, any utilisation), then withdraws `shares` of the pMUSD left (maxUint256 = all) and redeems what idle cash
 * allows; the rest comes back as pMUSD. Price updates go along only when debt remains while pMUSD is withdrawn
 * (`needsPrices`, from planUnwind): a full unwind needs none, so it works while a feed is stale or the relay is down.
 */
export const unwindSteps = (
  { hub, protocol, position }: Ctx,
  { shares, minOut, needsPrices }: { shares: bigint; minOut: bigint; needsPrices: boolean },
  isOperator: boolean,
): TxStep[] => [
  {
    label: 'Authorise LeverageManager',
    chainId: hubId,
    request: async () =>
      isOperator
        ? null
        : { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'setOperator', args: [d().contracts.leverageManager, true] },
  },
  {
    label: 'Unwind loop',
    chainId: hubId,
    request: async () => {
      const { updates, fee } = needsPrices ? await priceUpdate(hub, riskCheckSymbols(protocol, position)) : { updates: [] as Hex[], fee: 0n };
      return {
        address: d().contracts.leverageManager,
        abi: leverageManagerAbi,
        functionName: 'unwind',
        args: [maxUint256, shares, minOut, updates],
        value: fee,
      };
    },
  },
];

// --- BTC leverage (SwapLeverageManager on the Tigris DEX) --------------------------------

/** DEX legs expire, so a transaction signed late cannot fill at a stale quote. */
const swapDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
const swapLeverageManager = () => {
  const slm = d().contracts.swapLeverageManager;
  if (!slm) throw new Error('BTC leverage is not deployed on this network');
  return slm;
};

/**
 * Opens a BTC position: SwapLeverageManager flash-swaps BTC out of the Tigris MUSD/BTC pool, posts it with
 * `principal`, and borrows `borrowAmount` MUSD straight to the pool as payment (the debt is exactly that: no flash
 * fee; the MUSD pool needs that much idle cash). The BTC leg is priced even before it is held.
 */
export const btcLeverageSteps = (
  { account, hub, protocol, position }: Ctx,
  btc: CollateralState,
  principal: bigint,
  borrowAmount: bigint,
  minBought: bigint,
  isOperator: boolean,
): TxStep[] => [
  {
    label: 'Authorise SwapLeverageManager',
    chainId: hubId,
    request: async () =>
      isOperator ? null : { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'setOperator', args: [swapLeverageManager(), true] },
  },
  approveStep(hub, hubId, btc.token, account, swapLeverageManager(), principal, 'Approve BTC'),
  {
    label: 'Open BTC leverage',
    chainId: hubId,
    request: async () => {
      const symbols = riskCheckSymbols(protocol, position, 'MUSD');
      const { updates, fee } = await priceUpdate(
        hub,
        PRICE_SYMBOLS.filter((s) => s === 'BTC' || symbols.includes(s)),
      );
      return {
        address: swapLeverageManager(),
        abi: swapLeverageManagerAbi,
        functionName: 'open',
        args: [principal, borrowAmount, minBought, swapDeadline(), updates],
        value: fee,
      };
    },
  },
];

/**
 * Closes BTC leverage: sells `sellBtc` through a Tigris flash swap to repay the live MUSD debt (no MUSD pool cash
 * needed; the sale must raise at least the debt and `minProceeds`), withdraws all posted BTC and returns what was not
 * sold plus the MUSD left over. With no other debt the withdrawal needs no price, so updates go along only when
 * another market still has debt. A position built by hand first authorises SwapLeverageManager, which withdraws the
 * BTC for the account.
 */
export const btcCloseSteps = ({ hub, protocol, position }: Ctx, sellBtc: bigint, minProceeds: bigint, isOperator: boolean): TxStep[] => [
  {
    label: 'Authorise SwapLeverageManager',
    chainId: hubId,
    request: async () =>
      isOperator ? null : { address: d().contracts.vaultManager, abi: vaultManagerAbi, functionName: 'setOperator', args: [swapLeverageManager(), true] },
  },
  {
    label: 'Close BTC leverage',
    chainId: hubId,
    request: async () => {
      const musdId = protocol.markets.find((m) => m.symbol === 'MUSD')?.id;
      const otherDebt = !position || position.debts.some((x) => x.marketId !== musdId && x.amount > 0n);
      const { updates, fee } = otherDebt ? await priceUpdate(hub, riskCheckSymbols(protocol, position)) : { updates: [] as Hex[], fee: 0n };
      return {
        address: swapLeverageManager(),
        abi: swapLeverageManagerAbi,
        functionName: 'close',
        args: [maxUint256, maxUint256, sellBtc, minProceeds, swapDeadline(), updates],
        value: fee,
      };
    },
  },
];
