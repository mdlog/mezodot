import { NETWORKS, getHubDeployment, getSpokeDeployment, type HubDeployment, type NetworkName, type SpokeDeployment } from '@mezodot/sdk';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AgentConfig } from './config';
import { guardedFetch } from './net';
import { TxSender } from './tx';

export type Wallet = WalletClient<Transport, Chain, Account>;
export type Logger = (scope: string, message: string, extra?: Record<string, unknown>) => void;

export type ChainContext = {
  network: NetworkName;
  client: PublicClient;
  wallet: Wallet | null;
  /** The only way to send from the keeper on this chain (null when read-only). */
  sender: TxSender | null;
};
export type HubContext = ChainContext & { deployment: HubDeployment };
export type SpokeContext = ChainContext & { deployment: SpokeDeployment };

/** Clients and deployments for one environment (hub + spokes). */
export type Context = {
  config: AgentConfig;
  hub: HubContext;
  spokes: SpokeContext[];
  log: Logger;
  /** fetch for external HTTP services: a deadline per request and a circuit breaker per host. */
  fetch: typeof fetch;
};

/** Multicall3 (canonical address) on chains whose viem definition does not list it; checked on-chain 2026-10-18. */
const MULTICALL3: Partial<Record<NetworkName, Address>> = { 'mezo-testnet': '0xcA11bde05977b3631167028862bE2a173976CA11' };

export const logJson: Logger = (scope, message, extra) => console.error(JSON.stringify({ t: new Date().toISOString(), scope, message, ...extra }));

export function createContext(config: AgentConfig, log: Logger = logJson): Context {
  const hubDeployment = getHubDeployment(config.hub);
  if (!hubDeployment) throw new Error(`Hub ${config.hub} is not deployed (packages/sdk/src/deployments/${config.hub}.json)`);
  const account = config.keeperKey ? privateKeyToAccount(config.keeperKey) : null;

  const clientsFor = (network: NetworkName) => {
    const base = NETWORKS[network].chain;
    const multicall3 = base.contracts?.multicall3?.address ?? MULTICALL3[network];
    const chain: Chain = base.contracts?.multicall3 || !multicall3 ? base : { ...base, contracts: { ...base.contracts, multicall3: { address: multicall3 } } };
    const urls = config.rpc[network] ?? [base.rpcUrls.default.http[0]];
    const transport = urls.length > 1 ? fallback(urls.map((u) => http(u))) : http(urls[0]);
    // Concurrent reads are batched into Multicall3 calls where it is deployed: one position read is ~19 eth_calls.
    const client = createPublicClient({ chain, transport, batch: multicall3 ? { multicall: true } : undefined }) as PublicClient;
    const wallet = account ? (createWalletClient({ account, chain, transport }) as Wallet) : null;
    const sender = wallet ? new TxSender(network, client, wallet, { receiptTimeoutMs: config.receiptTimeoutMs, log }) : null;
    return { client, wallet, sender };
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
    log,
    fetch: guardedFetch(config.fetchTimeoutMs),
  };
}

/** Which contracts this agent runs against (logged at startup, served on /health). */
export function deploymentIdentity(ctx: Pick<Context, 'hub' | 'spokes'>) {
  const c = ctx.hub.deployment.contracts;
  return {
    hub: {
      network: ctx.hub.network,
      startBlock: ctx.hub.deployment.startBlock,
      vaultManager: c.vaultManager,
      wormholeAdapter: c.wormholeAdapter,
      keeperGateway: c.keeperGateway,
    },
    spokes: ctx.spokes.map((s) => ({ network: s.network, startBlock: s.deployment.startBlock, spokeGateway: s.deployment.contracts.spokeGateway })),
  };
}
