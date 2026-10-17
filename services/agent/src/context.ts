import { NETWORKS, getHubDeployment, getSpokeDeployment, type HubDeployment, type NetworkName, type SpokeDeployment } from '@mezodot/sdk';
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, type Account, type Chain, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AgentConfig } from './config';

export type Wallet = WalletClient<Transport, Chain, Account>;

export type SpokeContext = { network: NetworkName; deployment: SpokeDeployment; client: PublicClient; wallet: Wallet | null };

/** Clients and deployments for one environment (hub + spokes). */
export type Context = {
  config: AgentConfig;
  hub: { network: NetworkName; deployment: HubDeployment; client: PublicClient; wallet: Wallet | null };
  spokes: SpokeContext[];
  log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};

export function createContext(config: AgentConfig): Context {
  const hubDeployment = getHubDeployment(config.hub);
  if (!hubDeployment) throw new Error(`Hub ${config.hub} is not deployed (packages/sdk/src/deployments/${config.hub}.json)`);
  const account = config.keeperKey ? privateKeyToAccount(config.keeperKey) : null;

  const clientsFor = (network: NetworkName) => {
    const chain = NETWORKS[network].chain;
    const transport = http(config.rpc[network]);
    const client = createPublicClient({ chain, transport }) as PublicClient;
    const wallet = account ? (createWalletClient({ account, chain, transport }) as Wallet) : null;
    return { client, wallet };
  };

  const spokes: SpokeContext[] = [];
  for (const network of config.spokes) {
    const deployment = getSpokeDeployment(network);
    if (deployment) spokes.push({ network, deployment, ...clientsFor(network) });
  }

  return {
    config,
    hub: { network: config.hub, deployment: hubDeployment, ...clientsFor(config.hub) },
    spokes,
    log: (scope, message, extra) => console.error(JSON.stringify({ t: new Date().toISOString(), scope, message, ...extra })),
  };
}
