import { z } from 'zod';
import { ENVIRONMENTS, NETWORKS, PYTH_HERMES_URL, type EnvironmentName, type NetworkName } from '@mezodot/sdk';
import { parseEther, formatEther, type Hex } from 'viem';
import { urlHost } from './errors';

export const MODULES = ['relayer', 'liquidator', 'risk', 'http', 'oracle'] as const;
export type Module = (typeof MODULES)[number];

/**
 * What the liquidator does when the DEX would not pay back the repayment for seized plain collateral (BTC):
 * 'hold' liquidates anyway and keeps the collateral until a sale covers its cost, 'skip' leaves the account.
 */
export type UnsellablePolicy = 'hold' | 'skip';

export type AgentConfig = {
  env: EnvironmentName;
  hub: NetworkName;
  spokes: NetworkName[];
  /** RPC endpoints per network (RPC_<NETWORK>, comma-separated); more than one becomes a fallback transport. */
  rpc: Partial<Record<NetworkName, string[]>>;
  /** Keeper wallet; without it the agent runs read-only (no relays, no liquidations). */
  keeperKey: Hex | null;
  /** Devnet only: dev Wormhole guardian key used to sign VAAs locally. */
  devGuardianKey: Hex | null;
  modules: Set<Module>;
  pollMs: number;
  stateDir: string;
  /** Never write state files (the stdio MCP server follows the running agent's state instead). */
  stateReadOnly: boolean;
  httpHost: string;
  httpPort: number;
  /** MCP write tools execute only when true; otherwise they dry-run. Over HTTP also requires mcpToken. */
  mcpAllowWrite: boolean;
  /** Bearer token required on every /mcp HTTP request when set (MCP_TOKEN). */
  mcpToken: string | null;
  /** Extra Host headers accepted on /mcp, e.g. "agent.example.com" (MCP_ALLOWED_HOSTS, comma-separated). */
  mcpAllowedHosts: string[];
  /** Browser origins allowed to call /mcp (MCP_ALLOWED_ORIGINS, comma-separated; default none). */
  mcpAllowedOrigins: string[];
  /** Minimum liquidation profit in USD, net of gas and fees, before the liquidator sends a transaction. */
  minProfitUsd: number;
  /** Oracle watchdog (and optional pusher) interval. */
  oracleWatchMs: number;
  /** Optional Pyth API key (PYTH_API_KEY): enables the server-side Pyth pusher. Never sent to browsers. */
  pythApiKey: string | null;
  /** Hermes base URL used with pythApiKey. */
  hermesUrl: string;
  /** Supra DORA proof endpoint (SUPRA_PROOF_URL); defaults to the hub network's. */
  supraProofUrl: string | null;
  /** Signed-VAA sources per source network, tried in order (WORMHOLESCAN_API, then WORMHOLE_VAA_APIS). */
  vaaApis: Partial<Record<NetworkName, string[]>>;
  /** Deadline for every external HTTP request (FETCH_TIMEOUT_MS). */
  fetchTimeoutMs: number;
  /** How long a sent transaction may stay unmined before it is re-sent with higher fees (TX_RECEIPT_TIMEOUT_MS). */
  receiptTimeoutMs: number;
  /** Keeper native balance (wei) below which /health reports degraded (MIN_GAS_BALANCE_<NETWORK>). */
  minGasBalance: Partial<Record<NetworkName, bigint>>;
  /** Receives JSON alerts when a health check changes state (ALERT_WEBHOOK_URL). */
  alertWebhookUrl: string | null;
  unsellablePolicy: UnsellablePolicy;
  /** Largest discount to the oracle value accepted when selling seized collateral, in bps (MAX_SALE_DISCOUNT_BPS). */
  maxSaleDiscountBps: number;
};

/** Native gas each network's keeper should keep (BTC on Mezo, ETH elsewhere). */
const DEFAULT_MIN_GAS: Record<NetworkName, string> = {
  'mezo-testnet': '0.0001',
  'base-sepolia': '0.002',
  'eth-sepolia': '0.01',
  'devnet-hub': '1',
  'devnet-spoke': '1',
};

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid agent configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export const envKey = (prefix: string, network: NetworkName): string => `${prefix}_${network.toUpperCase().replace(/-/g, '_')}`;

// --- field schemas (every value arrives as a string; blank means unset) ----------------------------------------

const blank = (v: unknown) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v);
const text = z.preprocess(blank, z.string().optional());

/** Whole number; `_` is accepted as a digit separator (POLL_MS=6_000). */
const integer = (fallback: number, min: number, max: number) =>
  z
    .preprocess(
      blank,
      z
        .string()
        .regex(/^\d[\d_]*$/, 'must be a whole number, e.g. 6000')
        .optional(),
    )
    .transform((v) => (v === undefined ? fallback : Number(v.replace(/_/g, ''))))
    .pipe(z.number().int().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

const decimal = (fallback: number, min: number, max: number) =>
  z
    .preprocess(
      blank,
      z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a decimal number, e.g. 1.5')
        .optional(),
    )
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

/** Native token amount in whole units (MIN_GAS_BALANCE_<NETWORK>=0.002), as wei. */
const nativeAmount = (fallback: string) =>
  z
    .preprocess(
      blank,
      z
        .string()
        .regex(/^\d+(\.\d{1,18})?$/, 'must be a decimal amount of the native token, e.g. 0.002')
        .optional(),
    )
    .transform((v) => parseEther(v ?? fallback));

const flag = z
  .preprocess(blank, z.string().toLowerCase().optional())
  .refine((v) => v === undefined || ['true', 'false', '1', '0', 'yes', 'no'].includes(v), 'must be true or false')
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** 32-byte private key; a missing 0x prefix (MetaMask's export format) is accepted. The value never appears in errors. */
const privateKey = text.transform((v, ctx): Hex | null => {
  if (v === undefined) return null;
  const digits = /^0x/i.test(v) ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]{64}$/.test(digits)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a 32-byte hex private key (64 hex characters, optional 0x prefix)' });
    return z.NEVER;
  }
  return `0x${digits.toLowerCase()}`;
});

const httpUrl = z.string().superRefine((u, ctx) => {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a URL' });
    return;
  }
  if (!/^https?:$/.test(url.protocol)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an http(s) URL' });
});

const urlList = text.transform((v, ctx) => {
  const urls = csv(v);
  for (const u of urls) {
    const r = httpUrl.safeParse(u);
    if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${r.error.issues[0].message} (${urlHost(u)})` });
  }
  return urls.map((u) => u.replace(/\/$/, ''));
});

const optionalUrl = z.preprocess(blank, httpUrl.optional()).transform((v) => (v ? v.replace(/\/$/, '') : null));

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const envNames = Object.keys(ENVIRONMENTS) as [EnvironmentName, ...EnvironmentName[]];

const baseSchema = z.object({
  MEZODOT_ENV: z.preprocess(blank, z.enum(envNames, { required_error: `is required (${envNames.join(' | ')})` })),
  KEEPER_PRIVATE_KEY: privateKey,
  DEVNET_GUARDIAN_KEY: privateKey,
  AGENT_MODULES: text.transform((v, ctx) => {
    const asked = v === undefined ? [...MODULES] : csv(v);
    const unknown = asked.filter((m) => !(MODULES as readonly string[]).includes(m));
    if (unknown.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown module(s) ${unknown.join(', ')} (expected ${MODULES.join(', ')})` });
    if (asked.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `lists no module (expected some of ${MODULES.join(', ')})` });
    return new Set(asked as Module[]);
  }),
  POLL_MS: integer(4_000, 500, 600_000),
  STATE_DIR: text.transform((v) => v ?? '.state'),
  HTTP_HOST: text.transform((v) => v ?? '127.0.0.1'),
  HTTP_PORT: integer(8787, 0, 65_535),
  MCP_ALLOW_WRITE: flag,
  MCP_TOKEN: text.refine((v) => v === undefined || v.length >= 16, 'must be at least 16 characters (leave it empty to disable)'),
  MCP_ALLOWED_HOSTS: text.transform(csv),
  MCP_ALLOWED_ORIGINS: text.transform(csv),
  MIN_PROFIT_USD: decimal(1, 0, 1e9),
  ORACLE_WATCH_MS: integer(30_000, 5_000, 3_600_000),
  PYTH_API_KEY: text.transform((v) => v ?? null),
  HERMES_URL: optionalUrl,
  SUPRA_PROOF_URL: optionalUrl,
  WORMHOLESCAN_API: optionalUrl,
  WORMHOLE_VAA_APIS: urlList,
  FETCH_TIMEOUT_MS: integer(8_000, 1_000, 120_000),
  TX_RECEIPT_TIMEOUT_MS: integer(90_000, 10_000, 900_000),
  ALERT_WEBHOOK_URL: optionalUrl,
  LIQUIDATE_UNSELLABLE: z.preprocess(blank, z.enum(['hold', 'skip']).optional()).transform((v): UnsellablePolicy => v ?? 'hold'),
  MAX_SALE_DISCOUNT_BPS: integer(500, 0, 5_000),
});

const issueText = (issue: z.ZodIssue): string => `${issue.path.join('.') || 'environment'} ${issue.message}`;

/** Parses and validates the environment; throws ConfigError listing every invalid value (secrets never echoed). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = baseSchema.safeParse(env);
  const issues = parsed.success ? [] : parsed.error.issues.map(issueText);
  const name = parsed.success ? parsed.data.MEZODOT_ENV : (env.MEZODOT_ENV?.trim() as EnvironmentName | undefined);
  const e = name && name in ENVIRONMENTS ? ENVIRONMENTS[name] : null;

  // Per-network values: RPC_<NETWORK> and MIN_GAS_BALANCE_<NETWORK>.
  const rpc: AgentConfig['rpc'] = {};
  const minGasBalance: AgentConfig['minGasBalance'] = {};
  const vaaApis: AgentConfig['vaaApis'] = {};
  for (const n of e ? [e.hub, ...e.spokes] : []) {
    const key = envKey('RPC', n);
    const urls = urlList.safeParse(env[key]);
    if (!urls.success) issues.push(...urls.error.issues.map((i) => `${key} ${i.message}`));
    rpc[n] = urls.success && urls.data.length > 0 ? urls.data : [NETWORKS[n].chain.rpcUrls.default.http[0]];

    const gasKey = envKey('MIN_GAS_BALANCE', n);
    const gas = nativeAmount(DEFAULT_MIN_GAS[n]).safeParse(env[gasKey]);
    if (!gas.success) issues.push(...gas.error.issues.map((i) => `${gasKey} ${i.message}`));
    else minGasBalance[n] = gas.data;

    if (parsed.success && NETWORKS[n].wormholescanApi) {
      vaaApis[n] = [...new Set([parsed.data.WORMHOLESCAN_API ?? NETWORKS[n].wormholescanApi!, ...parsed.data.WORMHOLE_VAA_APIS])];
    }
  }
  if (issues.length > 0 || !parsed.success || !e) throw new ConfigError(issues.length > 0 ? issues : ['MEZODOT_ENV is required']);

  const d = parsed.data;
  return {
    env: d.MEZODOT_ENV,
    hub: e.hub,
    spokes: [...e.spokes],
    rpc,
    keeperKey: d.KEEPER_PRIVATE_KEY,
    devGuardianKey: d.MEZODOT_ENV === 'devnet' ? d.DEVNET_GUARDIAN_KEY : null,
    modules: d.AGENT_MODULES,
    pollMs: d.POLL_MS,
    stateDir: d.STATE_DIR,
    stateReadOnly: false,
    httpHost: d.HTTP_HOST,
    httpPort: d.HTTP_PORT,
    mcpAllowWrite: d.MCP_ALLOW_WRITE,
    mcpToken: d.MCP_TOKEN ?? null,
    mcpAllowedHosts: d.MCP_ALLOWED_HOSTS,
    mcpAllowedOrigins: d.MCP_ALLOWED_ORIGINS,
    minProfitUsd: d.MIN_PROFIT_USD,
    oracleWatchMs: d.ORACLE_WATCH_MS,
    pythApiKey: d.PYTH_API_KEY,
    hermesUrl: d.HERMES_URL ?? PYTH_HERMES_URL,
    supraProofUrl: d.SUPRA_PROOF_URL ?? NETWORKS[e.hub].supraProofUrl,
    vaaApis,
    fetchTimeoutMs: d.FETCH_TIMEOUT_MS,
    receiptTimeoutMs: d.TX_RECEIPT_TIMEOUT_MS,
    minGasBalance,
    alertWebhookUrl: d.ALERT_WEBHOOK_URL,
    unsellablePolicy: d.LIQUIDATE_UNSELLABLE,
    maxSaleDiscountBps: d.MAX_SALE_DISCOUNT_BPS,
  };
}

/** True for addresses only this machine can reach. */
export const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\./.test(host);

/** The effective configuration for the startup log: hosts instead of URLs, flags instead of secrets. */
export function describeConfig(c: AgentConfig) {
  return {
    env: c.env,
    modules: [...c.modules],
    rpc: Object.fromEntries(Object.entries(c.rpc).map(([n, urls]) => [n, urls.map(urlHost)])),
    keeper: c.keeperKey ? 'configured' : 'read-only',
    pollMs: c.pollMs,
    oracleWatchMs: c.oracleWatchMs,
    minProfitUsd: c.minProfitUsd,
    http: `${c.httpHost}:${c.httpPort}`,
    mcp: { token: c.mcpToken ? 'set' : 'unset', allowWrite: c.mcpAllowWrite, allowedHosts: c.mcpAllowedHosts, allowedOrigins: c.mcpAllowedOrigins },
    pythPusher: c.pythApiKey && c.env !== 'devnet' ? 'on' : 'off',
    vaaSources: Object.fromEntries(Object.entries(c.vaaApis).map(([n, urls]) => [n, urls.map(urlHost)])),
    supraProof: c.supraProofUrl ? urlHost(c.supraProofUrl) : null,
    minGasBalance: Object.fromEntries(Object.entries(c.minGasBalance).map(([n, wei]) => [n, formatEther(wei)])),
    alertWebhook: c.alertWebhookUrl ? 'set' : 'unset',
    liquidateUnsellable: c.unsellablePolicy,
    maxSaleDiscountBps: c.maxSaleDiscountBps,
    stateDir: c.stateDir,
  };
}
