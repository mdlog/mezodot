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

const requested = (import.meta.env.VITE_MEZODOT_ENV ?? 'testnet') as EnvironmentName;
export const ENV_NAME: EnvironmentName = requested in ENVIRONMENTS ? requested : 'testnet';

const env = ENVIRONMENTS[ENV_NAME];

export type HubInfo = NetworkInfo & { deployment: HubDeployment | null };
export type SpokeInfo = NetworkInfo & { deployment: SpokeDeployment | null };

export const HUB: HubInfo = { ...NETWORKS[env.hub], deployment: getHubDeployment(env.hub) };
export const SPOKES: SpokeInfo[] = env.spokes.map((n) => ({ ...NETWORKS[n], deployment: getSpokeDeployment(n) }));

/** True once the hub contracts exist for this environment. */
export const HUB_DEPLOYED = HUB.deployment !== null;

export const AGENT_URL = (import.meta.env.VITE_AGENT_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

export const spokeByWormholeChain = (chainId: number) => SPOKES.find((s) => s.wormholeChainId === chainId);

export const explorerTx = (network: NetworkInfo, hash: string): string | null => {
  const base = network.chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
};

export const explorerAddress = (network: NetworkInfo, address: string): string | null => {
  const base = network.chain.blockExplorers?.default.url;
  return base ? `${base}/address/${address}` : null;
};
