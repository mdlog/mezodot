import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { ENVIRONMENTS, NETWORKS, type EnvironmentName, type HubDeployment, type NetworkName, type SpokeDeployment } from '../../packages/sdk/src/index';

/** Where DeployHub / DeploySpoke write the deployment JSON that the SDK, agent and web read. */
export const DEPLOYMENTS_DIR = fileURLToPath(new URL('../../packages/sdk/src/deployments/', import.meta.url));

export const isNetworkName = (name: string): name is NetworkName => name in NETWORKS;

/** Reads `<dir>/<network>.json` from disk (not the SDK's bundled copy, so an uncommitted redeploy is checked as written). */
export function readDeploymentFile(network: NetworkName, dir: string = DEPLOYMENTS_DIR): unknown {
  return JSON.parse(readFileSync(`${dir}/${network}.json`, 'utf8'));
}

/** The environment (hub + spokes) a hub network belongs to. */
export function environmentOfHub(network: NetworkName): { env: EnvironmentName; hub: NetworkName; spokes: NetworkName[] } {
  for (const [env, e] of Object.entries(ENVIRONMENTS) as [EnvironmentName, (typeof ENVIRONMENTS)[EnvironmentName]][]) {
    if (e.hub === network) return { env, hub: e.hub, spokes: [...e.spokes] };
  }
  throw new Error(
    `${network} is not a hub network (expected one of ${Object.values(ENVIRONMENTS)
      .map((e) => e.hub)
      .join(', ')})`,
  );
}

/** Hub deployment JSON, or an error naming what is wrong with the file. */
export function asHubDeployment(network: NetworkName, raw: unknown): HubDeployment {
  const d = raw as Partial<HubDeployment> | null;
  if (!d || d.role !== 'hub' || typeof d.contracts !== 'object' || d.contracts === null) {
    throw new Error(`${network}.json is not a deployed hub (role "hub" with a contracts object expected)`);
  }
  return d as HubDeployment;
}

/** Spoke deployment JSON, or null for a placeholder (`contracts: null`, not deployed yet). */
export function asSpokeDeployment(network: NetworkName, raw: unknown): SpokeDeployment | null {
  const d = raw as Partial<SpokeDeployment> | null;
  if (d?.contracts == null) return null;
  if (d.role !== 'spoke') throw new Error(`${network}.json has role "${String(d.role)}", expected "spoke"`);
  return d as SpokeDeployment;
}

/**
 * RPC URLs in the agent's convention (RPC_MEZO_TESTNET, RPC_BASE_SEPOLIA, ...): one URL or a comma-separated list
 * tried in order, exactly as services/agent reads the same variable; else the SDK default.
 */
export function rpcUrls(network: NetworkName, env: NodeJS.ProcessEnv = process.env): string[] {
  const urls = (env[`RPC_${network.toUpperCase().replace(/-/g, '_')}`] ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  return urls.length > 0 ? urls : [NETWORKS[network].chain.rpcUrls.default.http[0]];
}

/** Hosts only, for display: an RPC URL can carry an API key in its path or query. */
export function rpcHosts(network: NetworkName, env: NodeJS.ProcessEnv = process.env): string {
  return rpcUrls(network, env)
    .map((url) => {
      try {
        return new URL(url).host;
      } catch {
        return 'custom RPC';
      }
    })
    .join(', ');
}

/** Read client over every configured URL: a fallback transport when there are several, as in the agent. */
export function publicClient(network: NetworkName, env: NodeJS.ProcessEnv = process.env): PublicClient {
  const urls = rpcUrls(network, env);
  // A list is retried as a whole (each URL in order, then again), a single URL on its own.
  const transport =
    urls.length > 1
      ? fallback(
          urls.map((url) => http(url, { timeout: 20_000 })),
          { retryCount: 3 },
        )
      : http(urls[0], { retryCount: 3, timeout: 20_000 });
  return createPublicClient({ chain: NETWORKS[network].chain, transport }) as PublicClient;
}

/** First line of an error message (viem errors carry multi-line details). */
export const errorLine = (err: unknown): string =>
  err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message.split('\n')[0]) : String(err);
