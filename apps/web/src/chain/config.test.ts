import { describe, expect, it } from 'vitest';
import { LOCAL_AGENT_URL, LOCAL_WALLETCONNECT_PROJECT_ID, isLocalUrl, readWebConfig, rpcVariable } from './config';

const opts = (production: boolean) => ({ production, environments: ['testnet', 'devnet'], networks: ['mezo-testnet', 'base-sepolia'] });
const good = { VITE_AGENT_URL: 'https://agent.mezodot.xyz/', VITE_WALLETCONNECT_PROJECT_ID: '3f2c9a' };

describe('web configuration', () => {
  it('falls back to local services in vite dev', () => {
    expect(readWebConfig({}, opts(false))).toEqual({
      envName: 'testnet',
      agentUrl: LOCAL_AGENT_URL,
      walletConnectProjectId: LOCAL_WALLETCONNECT_PROJECT_ID,
      rpcUrls: {},
      wormholescanApi: null,
      errors: [],
    });
  });

  it('refuses a production build without a reachable agent or a real WalletConnect id', () => {
    expect(readWebConfig({}, opts(true)).errors).toEqual([
      expect.stringMatching(/^VITE_AGENT_URL is not set/),
      expect.stringMatching(/^VITE_WALLETCONNECT_PROJECT_ID is not set/),
    ]);
    const local = readWebConfig({ ...good, VITE_AGENT_URL: 'http://127.0.0.1:8787' }, opts(true));
    expect(local.errors).toEqual([expect.stringMatching(/points at http:\/\/127.0.0.1:8787/)]);
    const placeholder = readWebConfig({ ...good, VITE_WALLETCONNECT_PROJECT_ID: LOCAL_WALLETCONNECT_PROJECT_ID }, opts(true));
    expect(placeholder.errors).toEqual([expect.stringMatching(/VITE_WALLETCONNECT_PROJECT_ID/)]);
  });

  it('accepts a complete production configuration, without the trailing slash', () => {
    expect(readWebConfig(good, opts(true))).toMatchObject({ agentUrl: 'https://agent.mezodot.xyz', walletConnectProjectId: '3f2c9a', errors: [] });
  });

  it('lets the devnet, or an explicit local preview, use localhost', () => {
    expect(readWebConfig({ VITE_MEZODOT_ENV: 'devnet' }, opts(true)).errors).toEqual([]);
    expect(readWebConfig({ ...good, VITE_AGENT_URL: 'http://localhost:8787', VITE_ALLOW_LOCALHOST: 'true' }, opts(true)).errors).toEqual([]);
  });

  it('says so when the environment name is unknown instead of silently using testnet', () => {
    const config = readWebConfig({ VITE_MEZODOT_ENV: 'mainnet' }, opts(false));
    expect(config.envName).toBe('testnet');
    expect(config.errors).toEqual([expect.stringMatching(/VITE_MEZODOT_ENV="mainnet" is not a Mezodot environment/)]);
  });

  it('rejects malformed URLs', () => {
    expect(readWebConfig({ VITE_AGENT_URL: 'agent:8787' }, opts(false)).errors).toEqual([expect.stringMatching(/not an http\(s\) URL/)]);
    expect(readWebConfig({ VITE_WORMHOLESCAN_API: 'ftp://x' }, opts(false)).errors).toHaveLength(1);
  });

  it('reads comma-separated RPC overrides per network', () => {
    const config = readWebConfig(
      { VITE_RPC_URL_MEZO_TESTNET: 'https://a.example, https://b.example', VITE_RPC_URL_BASE_SEPOLIA: 'https://c, nope' },
      opts(false),
    );
    expect(config.rpcUrls).toEqual({ 'mezo-testnet': ['https://a.example', 'https://b.example'] });
    expect(config.errors).toEqual([expect.stringMatching(/^VITE_RPC_URL_BASE_SEPOLIA has entries that are not http\(s\) URLs: nope/)]);
    expect(rpcVariable('eth-sepolia')).toBe('VITE_RPC_URL_ETH_SEPOLIA');
  });

  it('knows what counts as local', () => {
    expect(['http://localhost:3000', 'http://127.0.0.1', 'http://0.0.0.0:1', 'http://app.localhost'].every(isLocalUrl)).toBe(true);
    expect(isLocalUrl('https://agent.mezodot.xyz')).toBe(false);
  });
});
