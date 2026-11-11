/**
 * The web app's build-time configuration (VITE_* variables), validated in one place. vite.config.ts refuses a
 * production build that has errors, and the app shows them on a blocking screen if one slips through anyway.
 * The local defaults (an agent on 127.0.0.1, a placeholder WalletConnect id) are for `vite dev` and devnet only.
 * VITE_WALLETCONNECT_PROJECT_ID=none builds without WalletConnect instead of a real project id.
 *
 * Kept free of SDK and browser imports so vite.config.ts can load it in Node.
 */

export const LOCAL_AGENT_URL = 'http://127.0.0.1:8787';
export const LOCAL_WALLETCONNECT_PROJECT_ID = 'mezodot-local-dev';
/** VITE_WALLETCONNECT_PROJECT_ID value that turns WalletConnect off on purpose. */
export const WALLETCONNECT_OFF = 'none';
export const DEFAULT_ENV = 'testnet';

/** import.meta.env, or the result of Vite's loadEnv: string values (Vite adds a few booleans). */
export type RawWebEnv = Readonly<Record<string, string | boolean | undefined>>;

export type WebConfig = {
  /** Environment name; DEFAULT_ENV when VITE_MEZODOT_ENV is unset or invalid (then `errors` says so). */
  envName: string;
  agentUrl: string;
  walletConnectProjectId: string;
  /** A real project id is set: only then does the app offer WalletConnect-based wallets. */
  walletConnect: boolean;
  /** RPC endpoints per network name, tried in order before the chain's public default. */
  rpcUrls: Record<string, string[]>;
  /** Replaces the Wormholescan API base of every network that has one. */
  wormholescanApi: string | null;
  /** Problems that make this build unsafe to serve; empty when the configuration is usable. */
  errors: string[];
};

export type ConfigOptions = {
  /** A production bundle: services must be real, reachable hosts. */
  production: boolean;
  /** Valid VITE_MEZODOT_ENV values (keys of the SDK's ENVIRONMENTS). */
  environments: readonly string[];
  /** Network names that accept a VITE_RPC_URL_<NAME> override. */
  networks: readonly string[];
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

const text = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export const isLocalUrl = (value: string): boolean => {
  const url = httpUrl(value);
  return url !== null && (LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost'));
};

/** `base-sepolia` → `VITE_RPC_URL_BASE_SEPOLIA`. */
export const rpcVariable = (network: string): string => `VITE_RPC_URL_${network.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

export function readWebConfig(env: RawWebEnv, opts: ConfigOptions): WebConfig {
  const errors: string[] = [];
  const requestedEnv = text(env.VITE_MEZODOT_ENV);
  let envName = requestedEnv ?? DEFAULT_ENV;
  if (!opts.environments.includes(envName)) {
    errors.push(`VITE_MEZODOT_ENV="${envName}" is not a Mezodot environment (expected ${opts.environments.join(' or ')}).`);
    envName = DEFAULT_ENV;
  }
  // The devnet runs on this machine by definition; anything else must reach public hosts once it is built.
  const strict = opts.production && envName !== 'devnet' && env.VITE_ALLOW_LOCALHOST !== 'true';

  const agent = text(env.VITE_AGENT_URL);
  let agentUrl = LOCAL_AGENT_URL;
  if (agent === undefined) {
    if (strict) errors.push('VITE_AGENT_URL is not set: price proofs, relay status and the risk report come from the Mezodot agent.');
  } else if (!httpUrl(agent)) {
    errors.push(`VITE_AGENT_URL="${agent}" is not an http(s) URL.`);
  } else {
    agentUrl = agent.replace(/\/+$/, '');
    if (strict && isLocalUrl(agent)) errors.push(`VITE_AGENT_URL points at ${agent}: every visitor's browser would call its own machine.`);
  }

  const projectId = text(env.VITE_WALLETCONNECT_PROJECT_ID);
  const optedOut = projectId?.toLowerCase() === WALLETCONNECT_OFF;
  const walletConnect = projectId !== undefined && !optedOut && projectId !== LOCAL_WALLETCONNECT_PROJECT_ID;
  if (strict && !walletConnect && !optedOut) {
    errors.push(
      'VITE_WALLETCONNECT_PROJECT_ID is not set: a real project id (cloud.reown.com) for WalletConnect and mobile wallets, or "none" to build without WalletConnect.',
    );
  }

  const rpcUrls: Record<string, string[]> = {};
  for (const network of opts.networks) {
    const variable = rpcVariable(network);
    const raw = text(env[variable]);
    if (raw === undefined) continue;
    const urls = raw
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    const bad = urls.filter((u) => !httpUrl(u));
    if (bad.length > 0) errors.push(`${variable} has entries that are not http(s) URLs: ${bad.join(', ')}.`);
    else rpcUrls[network] = urls;
  }

  const wormholescan = text(env.VITE_WORMHOLESCAN_API);
  let wormholescanApi: string | null = null;
  if (wormholescan !== undefined) {
    if (httpUrl(wormholescan)) wormholescanApi = wormholescan.replace(/\/+$/, '');
    else errors.push(`VITE_WORMHOLESCAN_API="${wormholescan}" is not an http(s) URL.`);
  }

  const walletConnectProjectId = walletConnect ? projectId! : LOCAL_WALLETCONNECT_PROJECT_ID;
  return { envName, agentUrl, walletConnectProjectId, walletConnect, rpcUrls, wormholescanApi, errors };
}
