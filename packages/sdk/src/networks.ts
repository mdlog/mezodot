import { defineChain, type Chain } from 'viem';
import { baseSepolia, sepolia } from 'viem/chains';

export type NetworkName = 'mezo-testnet' | 'base-sepolia' | 'eth-sepolia' | 'devnet-hub' | 'devnet-spoke';
export type Role = 'hub' | 'spoke';

export const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.test.mezo.org'], webSocket: ['wss://rpc-ws.test.mezo.org'] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' } },
  testnet: true,
});

export const devnetHub = defineChain({
  id: 31337,
  name: 'Devnet Hub (Mezo)',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
});

export const devnetSpoke = defineChain({
  id: 31338,
  name: 'Devnet Spoke (Base)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8546'] } },
  testnet: true,
});

export type NetworkInfo = {
  name: NetworkName;
  label: string;
  role: Role;
  chain: Chain;
  wormholeChainId: number;
  /** Wormholescan API base for signed VAAs; null on the local devnet (self-signed VAAs). */
  wormholescanApi: string | null;
  /** Pyth Hermes-compatible price service. */
  hermesUrl: string;
};

const HERMES = 'https://hermes.pyth.network';
const WORMHOLESCAN_TESTNET = 'https://api.testnet.wormholescan.io';
/** Devnet price service served by the agent (mimics the Hermes API with MockPyth payloads). */
export const DEVNET_HERMES = 'http://127.0.0.1:8787/hermes';

export const NETWORKS: Record<NetworkName, NetworkInfo> = {
  'mezo-testnet': { name: 'mezo-testnet', label: 'Mezo Testnet', role: 'hub', chain: mezoTestnet, wormholeChainId: 50, wormholescanApi: WORMHOLESCAN_TESTNET, hermesUrl: HERMES },
  'base-sepolia': { name: 'base-sepolia', label: 'Base Sepolia', role: 'spoke', chain: baseSepolia, wormholeChainId: 10004, wormholescanApi: WORMHOLESCAN_TESTNET, hermesUrl: HERMES },
  'eth-sepolia': { name: 'eth-sepolia', label: 'Ethereum Sepolia', role: 'spoke', chain: sepolia, wormholeChainId: 10002, wormholescanApi: WORMHOLESCAN_TESTNET, hermesUrl: HERMES },
  'devnet-hub': { name: 'devnet-hub', label: 'Devnet Hub', role: 'hub', chain: devnetHub, wormholeChainId: 50, wormholescanApi: null, hermesUrl: DEVNET_HERMES },
  'devnet-spoke': { name: 'devnet-spoke', label: 'Devnet Spoke (Base)', role: 'spoke', chain: devnetSpoke, wormholeChainId: 10004, wormholescanApi: null, hermesUrl: DEVNET_HERMES },
};

/** Hub + spokes that belong together. */
export const ENVIRONMENTS = {
  testnet: { hub: 'mezo-testnet', spokes: ['base-sepolia', 'eth-sepolia'] },
  devnet: { hub: 'devnet-hub', spokes: ['devnet-spoke'] },
} as const satisfies Record<string, { hub: NetworkName; spokes: readonly NetworkName[] }>;

export type EnvironmentName = keyof typeof ENVIRONMENTS;

export const networkByWormholeChain = (env: EnvironmentName, wormholeChainId: number): NetworkInfo | undefined => {
  const e = ENVIRONMENTS[env];
  return [e.hub, ...e.spokes].map((n) => NETWORKS[n]).find((n) => n.wormholeChainId === wormholeChainId);
};
