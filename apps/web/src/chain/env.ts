import {
  ENVIRONMENTS,
  NETWORKS,
  getHubDeployment,
  getSpokeDeployment,
  type EnvironmentName,
  type HubDeployment,
  type NetworkInfo,
  type SpokeDeployment,
} from '@mezodot/sdk';
import { readWebConfig } from './config';

const CONFIG = readWebConfig(import.meta.env, {
  production: import.meta.env.PROD,
  environments: Object.keys(ENVIRONMENTS),
  networks: Object.keys(NETWORKS),
});

/** Configuration problems that make the app unsafe to use; App renders a blocking screen while non-empty. */
export const CONFIG_ERRORS: readonly string[] = CONFIG.errors;

export const ENV_NAME = CONFIG.envName as EnvironmentName;

const env = ENVIRONMENTS[ENV_NAME];

export type HubInfo = NetworkInfo & { deployment: HubDeployment | null };
export type SpokeInfo = NetworkInfo & { deployment: SpokeDeployment | null };

const withOverrides = (n: NetworkInfo): NetworkInfo => (CONFIG.wormholescanApi && n.wormholescanApi ? { ...n, wormholescanApi: CONFIG.wormholescanApi } : n);

export const HUB: HubInfo = { ...withOverrides(NETWORKS[env.hub]), deployment: getHubDeployment(env.hub) };
export const SPOKES: SpokeInfo[] = env.spokes.map((n) => ({ ...withOverrides(NETWORKS[n]), deployment: getSpokeDeployment(n) }));

/** True once the hub contracts exist for this environment. */
export const HUB_DEPLOYED = HUB.deployment !== null;

/** Mezodot agent HTTP API (price proofs, relay status, KPIs). Localhost only in `vite dev` and on the devnet. */
export const AGENT_URL = CONFIG.agentUrl;

export const WALLETCONNECT_PROJECT_ID = CONFIG.walletConnectProjectId;

/** RPC endpoints for `network`: VITE_RPC_URL_* overrides first, then the chain's public default. */
export const rpcUrlsFor = (network: NetworkInfo): string[] => [...(CONFIG.rpcUrls[network.name] ?? []), ...network.chain.rpcUrls.default.http];

export const networkByName = (name: string): HubInfo | SpokeInfo | undefined => (name === HUB.name ? HUB : SPOKES.find((s) => s.name === name));

export const spokeByWormholeChain = (chainId: number) => SPOKES.find((s) => s.wormholeChainId === chainId);

export const explorerTx = (network: NetworkInfo, hash: string): string | null => {
  const base = network.chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
};

export const explorerAddress = (network: NetworkInfo, address: string): string | null => {
  const base = network.chain.blockExplorers?.default.url;
  return base ? `${base}/address/${address}` : null;
};
