import type { Address, Hex } from 'viem';
import type { NetworkName } from './networks';
import mezoTestnet from './deployments/mezo-testnet.json';
import baseSepolia from './deployments/base-sepolia.json';
import ethSepolia from './deployments/eth-sepolia.json';
import devnetHub from './deployments/devnet-hub.json';
import devnetSpoke from './deployments/devnet-spoke.json';

/** Written by contracts/script/DeployHub.s.sol. */
export type HubDeployment = {
  network: NetworkName;
  role: 'hub';
  chainId: number;
  wormholeChainId: number;
  startBlock: number;
  contracts: {
    vaultManager: Address;
    oracleRouter: Address;
    wormholeAdapter: Address;
    leverageManager: Address;
    keeperGateway: Address;
    pMUSD: Address;
    pMEZO: Address;
    wormhole: Address;
    /** Pyth Core used by the router's Pyth source. */
    pyth: Address;
    /** Supra DORA pull contract behind the router's Supra source (zero address when not configured). */
    supraPull: Address;
    /** BTC leverage through the Tigris DEX, and the router/factory it swaps on (absent on older deployments). */
    swapLeverageManager?: Address;
    tigrisRouter?: Address;
    tigrisFactory?: Address;
  };
  tokens: { MUSD: Address; MEZO: Address; BTC?: Address };
  priceFeeds: { MUSD: Hex; MEZO: Hex; ETH: Hex; USDC: Hex; BTC?: Hex };
};

/** Written by contracts/script/DeploySpoke.s.sol. */
export type SpokeDeployment = {
  network: NetworkName;
  role: 'spoke';
  chainId: number;
  wormholeChainId: number;
  startBlock: number;
  contracts: { spokeGateway: Address; wormhole: Address };
  tokens: { WETH: Address; USDC: Address };
};

type RawDeployment = { network: string; role: string; contracts: unknown };

const RAW: Record<NetworkName, RawDeployment> = {
  'mezo-testnet': mezoTestnet,
  'base-sepolia': baseSepolia,
  'eth-sepolia': ethSepolia,
  'devnet-hub': devnetHub,
  'devnet-spoke': devnetSpoke,
};

/** Placeholder files have `contracts: null` until the network is deployed. */
export const isDeployed = (network: NetworkName): boolean => RAW[network]?.contracts != null;

export function getHubDeployment(network: NetworkName): HubDeployment | null {
  const raw = RAW[network];
  if (!raw || raw.role !== 'hub' || raw.contracts == null) return null;
  return raw as unknown as HubDeployment;
}

export function getSpokeDeployment(network: NetworkName): SpokeDeployment | null {
  const raw = RAW[network];
  if (!raw || raw.role !== 'spoke' || raw.contracts == null) return null;
  return raw as unknown as SpokeDeployment;
}
