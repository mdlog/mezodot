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
  /** Supra DORA `get_proof` endpoint for pull prices on the hub; null where the agent mocks it (devnet) or on spokes. */
  supraProofUrl: string | null;
  /** Largest eth_getLogs block range the default public RPC accepts (Base Sepolia: 200; Mezo: 10,000). */
  maxLogRange: bigint;
};

const WORMHOLESCAN_TESTNET = 'https://api.testnet.wormholescan.io';
/** Supra DORA testnet proofs (keyless). Mezo testnet's pull contract only accepts testnet committee signatures. */
export const SUPRA_TESTNET_PROOF_URL = 'https://rpc-testnet-dora-2.supra.com/get_proof';

export const NETWORKS: Record<NetworkName, NetworkInfo> = {
  'mezo-testnet': {
    name: 'mezo-testnet',
    label: 'Mezo Testnet',
    role: 'hub',
    chain: mezoTestnet,
    wormholeChainId: 50,
    wormholescanApi: WORMHOLESCAN_TESTNET,
    supraProofUrl: SUPRA_TESTNET_PROOF_URL,
    maxLogRange: 5_000n,
  },
  'base-sepolia': {
    name: 'base-sepolia',
    label: 'Base Sepolia',
    role: 'spoke',
    chain: baseSepolia,
    wormholeChainId: 10004,
    wormholescanApi: WORMHOLESCAN_TESTNET,
    supraProofUrl: null,
    // sepolia.base.org: "eth_getLogs is limited to a 200 range" (measured 2026-10-18)
    maxLogRange: 200n,
  },
  'eth-sepolia': {
    name: 'eth-sepolia',
    label: 'Ethereum Sepolia',
    role: 'spoke',
    chain: sepolia,
    wormholeChainId: 10002,
    wormholescanApi: WORMHOLESCAN_TESTNET,
    supraProofUrl: null,
    maxLogRange: 5_000n,
  },
  'devnet-hub': {
    name: 'devnet-hub',
    label: 'Devnet Hub',
    role: 'hub',
    chain: devnetHub,
    wormholeChainId: 50,
    wormholescanApi: null,
    supraProofUrl: null,
    maxLogRange: 5_000n,
  },
  'devnet-spoke': {
    name: 'devnet-spoke',
    label: 'Devnet Spoke (Base)',
    role: 'spoke',
    chain: devnetSpoke,
    wormholeChainId: 10004,
    wormholescanApi: null,
    supraProofUrl: null,
    maxLogRange: 5_000n,
  },
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
