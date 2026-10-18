import { erc20Abi, keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { pTokenAbi, vaultManagerAbi, keeperGatewayAbi } from './abis';
import type { HubDeployment } from './deployments';

export const PRICE_SYMBOLS = ['MUSD', 'MEZO', 'ETH', 'USDC', 'BTC'] as const;
export type PriceSymbol = (typeof PRICE_SYMBOLS)[number];
/** OracleRouter keys are keccak256(symbol). */
export const PRICE_KEYS: Record<PriceSymbol, Hex> = Object.fromEntries(PRICE_SYMBOLS.map((s) => [s, keccak256(toHex(s))])) as Record<PriceSymbol, Hex>;
export const symbolForPriceKey = (key: Hex): PriceSymbol | undefined => PRICE_SYMBOLS.find((s) => PRICE_KEYS[s] === key.toLowerCase());

export type MarketState = {
  id: number;
  symbol: string;
  receiptSymbol: string;
  pool: Address;
  asset: Address;
  decimals: number;
  shareDecimals: number;
  priceKey: Hex;
  totalAssets: bigint;
  totalBorrows: bigint;
  totalReserves: bigint;
  cash: bigint;
  totalSupply: bigint;
  /** Underlying per one whole share (10**shareDecimals). */
  exchangeRate: bigint;
  borrowRatePerSecond: bigint;
  supplyRatePerSecond: bigint;
  supplyCap: bigint;
  borrowCap: bigint;
  /** Share of borrower interest kept as reserves (WAD), owner-set up to 30%. */
  reserveFactor: bigint;
};

export type CollateralState = {
  id: number;
  enabled: boolean;
  isRemote: boolean;
  /** Hub collateral that is a pToken share (valued through its exchange rate); false for plain tokens (BTC) and remote. */
  isShare: boolean;
  token: Address;
  chainId: number;
  remoteToken: Hex;
  decimals: number;
  priceKey: Hex;
  ltvBps: number;
  ltBps: number;
  bonusBps: number;
  cap: bigint;
  total: bigint;
  /** e.g. pMUSD, pMEZO, BTC, WETH, USDC */
  symbol: string;
};

/** Markets and collateral config. Prices live in the oracle state (see readOracle in oracle.ts). */
export type ProtocolState = {
  markets: MarketState[];
  collaterals: CollateralState[];
  keeperCount: bigint;
  blockNumber: bigint;
  /** Protocol share of each liquidation bonus, in bps of the bonus. */
  liquidationFeeBps: number;
  /** Account credited with the protocol's share of seized collateral. */
  treasury: Address;
};

export type PositionState = {
  account: Address;
  snapshot: { collateralValue: bigint; adjustedCollateral: bigint; borrowLimit: bigint; debtValue: bigint; healthFactor: bigint };
  collateral: { id: number; balance: bigint; valueUsd: bigint }[];
  debts: { marketId: number; amount: bigint }[];
  isLeverageOperator: boolean;
  /** Whether SwapLeverageManager (BTC leverage) may act for the account; false when it is not deployed. */
  isSwapLeverageOperator: boolean;
};

const REMOTE_SYMBOL: Partial<Record<PriceSymbol, string>> = { ETH: 'WETH', USDC: 'USDC' };

export async function readProtocol(client: PublicClient, hub: HubDeployment): Promise<ProtocolState> {
  const vm = hub.contracts.vaultManager;
  const [marketCount, collateralCount, keeperCount, blockNumber, liquidationFeeBps, treasury] = await Promise.all([
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'marketCount' }),
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collateralCount' }),
    client.readContract({ address: hub.contracts.keeperGateway, abi: keeperGatewayAbi, functionName: 'keeperCount' }),
    client.getBlockNumber(),
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'liquidationFeeBps' }),
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'treasury' }),
  ]);

  const markets = await Promise.all(
    Array.from({ length: Number(marketCount) }, async (_, id): Promise<MarketState> => {
      const m = await client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'markets', args: [BigInt(id)] });
      const pool = m.pool;
      const read = <
        F extends
          | 'totalAssets'
          | 'totalBorrows'
          | 'totalReserves'
          | 'cash'
          | 'totalSupply'
          | 'exchangeRate'
          | 'borrowRatePerSecond'
          | 'supplyRatePerSecond'
          | 'supplyCap'
          | 'borrowCap'
          | 'reserveFactor',
      >(
        functionName: F,
      ) => client.readContract({ address: pool, abi: pTokenAbi, functionName }) as Promise<bigint>;
      const [
        asset,
        shareDecimals,
        receiptSymbol,
        totalAssets,
        totalBorrows,
        totalReserves,
        cash,
        totalSupply,
        exchangeRate,
        borrowRatePerSecond,
        supplyRatePerSecond,
        supplyCap,
        borrowCap,
        reserveFactor,
      ] = await Promise.all([
        client.readContract({ address: pool, abi: pTokenAbi, functionName: 'asset' }),
        client.readContract({ address: pool, abi: pTokenAbi, functionName: 'decimals' }),
        client.readContract({ address: pool, abi: pTokenAbi, functionName: 'symbol' }),
        read('totalAssets'),
        read('totalBorrows'),
        read('totalReserves'),
        read('cash'),
        read('totalSupply'),
        read('exchangeRate'),
        read('borrowRatePerSecond'),
        read('supplyRatePerSecond'),
        read('supplyCap'),
        read('borrowCap'),
        read('reserveFactor'),
      ]);
      const symbol = await client.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' });
      return {
        id,
        symbol,
        receiptSymbol,
        pool,
        asset,
        decimals: m.decimals,
        shareDecimals,
        priceKey: m.priceKey,
        totalAssets,
        totalBorrows,
        totalReserves,
        cash,
        totalSupply,
        exchangeRate,
        borrowRatePerSecond,
        supplyRatePerSecond,
        supplyCap,
        borrowCap,
        reserveFactor,
      };
    }),
  );

  const collaterals = await Promise.all(
    Array.from({ length: Number(collateralCount) }, async (_, id): Promise<CollateralState> => {
      const [c, total] = await Promise.all([
        client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collaterals', args: [BigInt(id)] }),
        client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'totalCollateral', args: [BigInt(id)] }),
      ]);
      const priceSymbol = symbolForPriceKey(c.priceKey);
      const symbol = c.isRemote
        ? ((priceSymbol && REMOTE_SYMBOL[priceSymbol]) ?? 'REMOTE')
        : c.isShare
          ? (markets.find((m) => m.pool.toLowerCase() === c.token.toLowerCase())?.receiptSymbol ?? 'pToken')
          : (priceSymbol ?? 'TOKEN');
      return {
        id,
        enabled: c.enabled,
        isRemote: c.isRemote,
        isShare: c.isShare,
        token: c.token,
        chainId: c.chainId,
        remoteToken: c.remoteToken,
        decimals: c.decimals,
        priceKey: c.priceKey,
        ltvBps: c.ltvBps,
        ltBps: c.ltBps,
        bonusBps: c.bonusBps,
        cap: c.cap,
        total,
        symbol,
      };
    }),
  );

  return { markets, collaterals, keeperCount, blockNumber, liquidationFeeBps, treasury };
}

export async function readPosition(client: PublicClient, hub: HubDeployment, protocol: ProtocolState, account: Address): Promise<PositionState> {
  const vm = hub.contracts.vaultManager;
  const swap = hub.contracts.swapLeverageManager;
  const [snapshot, isLeverageOperator, isSwapLeverageOperator, collateral, debts] = await Promise.all([
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'getRiskSnapshot', args: [account] }),
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'isOperator', args: [account, hub.contracts.leverageManager] }),
    swap ? client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'isOperator', args: [account, swap] }) : Promise.resolve(false),
    Promise.all(
      protocol.collaterals.map(async (c) => {
        const [balance, valueUsd] = await Promise.all([
          client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collateralBalance', args: [account, BigInt(c.id)] }),
          client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collateralValue', args: [account, BigInt(c.id)] }),
        ]);
        return { id: c.id, balance, valueUsd };
      }),
    ),
    Promise.all(
      protocol.markets.map(async (m) => ({
        marketId: m.id,
        amount: await client.readContract({ address: m.pool, abi: pTokenAbi, functionName: 'borrowBalanceView', args: [account] }),
      })),
    ),
  ]);
  return { account, snapshot, collateral, debts, isLeverageOperator, isSwapLeverageOperator };
}
