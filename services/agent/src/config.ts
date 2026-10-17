import { ENVIRONMENTS, NETWORKS, type EnvironmentName, type NetworkName } from '@mezodot/sdk';
import type { Hex } from 'viem';

export type Module = 'relayer' | 'liquidator' | 'risk' | 'http';

export type AgentConfig = {
  env: EnvironmentName;
  hub: NetworkName;
  spokes: NetworkName[];
  rpc: Partial<Record<NetworkName, string>>;
  /** Keeper wallet; without it the agent runs read-only (no relays, no liquidations). */
  keeperKey: Hex | null;
  /** Devnet only: dev Wormhole guardian key used to sign VAAs locally. */
  devGuardianKey: Hex | null;
  modules: Set<Module>;
  pollMs: number;
  stateDir: string;
  httpPort: number;
  /** MCP write tools execute only when true; otherwise they dry-run. */
  mcpAllowWrite: boolean;
  /** Minimum liquidation profit in USD before the liquidator sends a transaction. */
  minProfitUsd: number;
};

const hex = (v: string | undefined): Hex | null => (v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const name = (env.MEZODOT_ENV ?? 'devnet') as EnvironmentName;
  if (!(name in ENVIRONMENTS)) throw new Error(`Unknown MEZODOT_ENV "${name}" (expected devnet | testnet)`);
  const e = ENVIRONMENTS[name];
  const rpc: AgentConfig['rpc'] = {};
  for (const n of [e.hub, ...e.spokes]) {
    const key = `RPC_${n.toUpperCase().replace(/-/g, '_')}`;
    rpc[n] = env[key] ?? NETWORKS[n].chain.rpcUrls.default.http[0];
  }
  const modules = new Set(
    (env.AGENT_MODULES ?? 'relayer,liquidator,risk,http')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean) as Module[],
  );
  return {
    env: name,
    hub: e.hub,
    spokes: [...e.spokes],
    rpc,
    keeperKey: hex(env.KEEPER_PRIVATE_KEY),
    devGuardianKey: name === 'devnet' ? hex(env.DEVNET_GUARDIAN_KEY) : null,
    modules,
    pollMs: Number(env.POLL_MS ?? 4_000),
    stateDir: env.STATE_DIR ?? '.state',
    httpPort: Number(env.HTTP_PORT ?? 8787),
    mcpAllowWrite: env.MCP_ALLOW_WRITE === 'true',
    minProfitUsd: Number(env.MIN_PROFIT_USD ?? 1),
  };
}
