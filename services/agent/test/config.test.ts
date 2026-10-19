import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { ConfigError, describeConfig, isLoopbackHost, loadConfig } from '../src/config';

const KEY = '2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';

/** The ConfigError issues `env` produces (empty when it parses). */
const issues = (env: Record<string, string>): string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
};

describe('agent configuration fails closed (config-validation, config-silent-fallbacks)', () => {
  it('requires MEZODOT_ENV instead of silently running against the devnet', () => {
    expect(issues({})).toEqual([expect.stringMatching(/^MEZODOT_ENV is required \(testnet \| devnet\)/)]);
    expect(issues({ MEZODOT_ENV: 'mainnet' })[0]).toMatch(/^MEZODOT_ENV /);
  });

  it('fills documented defaults for a minimal configuration', () => {
    const c = loadConfig({ MEZODOT_ENV: 'testnet' });
    expect(c).toMatchObject({
      env: 'testnet',
      hub: 'mezo-testnet',
      spokes: ['base-sepolia', 'eth-sepolia'],
      keeperKey: null,
      pollMs: 4_000,
      httpHost: '127.0.0.1',
      httpPort: 8787,
      minProfitUsd: 1,
      mcpAllowWrite: false,
      mcpToken: null,
      unsellablePolicy: 'hold',
      maxSaleDiscountBps: 500,
      fetchTimeoutMs: 8_000,
      alertWebhookUrl: null,
      supraProofUrl: 'https://rpc-testnet-dora-2.supra.com/get_proof',
    });
    expect([...c.modules]).toEqual(['relayer', 'liquidator', 'risk', 'http', 'oracle']);
    expect(c.rpc['mezo-testnet']).toEqual(['https://rpc.test.mezo.org']);
    expect(c.vaaApis['base-sepolia']).toEqual(['https://api.testnet.wormholescan.io']);
    expect(c.minGasBalance['mezo-testnet']).toBe(parseEther('0.0001'));
    expect(loadConfig({ MEZODOT_ENV: 'devnet' }).vaaApis).toEqual({}); // the agent signs devnet VAAs itself
  });

  it('rejects intervals that are not whole numbers (POLL_MS=6s used to fire every millisecond)', () => {
    expect(issues({ MEZODOT_ENV: 'devnet', POLL_MS: '6s' })).toEqual(['POLL_MS must be a whole number, e.g. 6000']);
    expect(issues({ MEZODOT_ENV: 'devnet', POLL_MS: '0' })).toEqual(['POLL_MS must be at least 500']);
    expect(loadConfig({ MEZODOT_ENV: 'devnet', POLL_MS: '6_000' }).pollMs).toBe(6_000);
    expect(issues({ MEZODOT_ENV: 'devnet', ORACLE_WATCH_MS: 'NaN' })).toHaveLength(1);
  });

  it('rejects a profit floor that is not a number (MIN_PROFIT_USD=1usd used to disable the filter)', () => {
    expect(issues({ MEZODOT_ENV: 'devnet', MIN_PROFIT_USD: '1usd' })).toEqual(['MIN_PROFIT_USD must be a decimal number, e.g. 1.5']);
    expect(loadConfig({ MEZODOT_ENV: 'devnet', MIN_PROFIT_USD: '2.5' }).minProfitUsd).toBe(2.5);
  });

  it('accepts a keeper key without 0x or with stray whitespace, and rejects anything else without echoing it', () => {
    expect(loadConfig({ MEZODOT_ENV: 'devnet', KEEPER_PRIVATE_KEY: ` ${KEY.toUpperCase()}\n` }).keeperKey).toBe(`0x${KEY}`);
    expect(loadConfig({ MEZODOT_ENV: 'devnet', KEEPER_PRIVATE_KEY: `0x${KEY}` }).keeperKey).toBe(`0x${KEY}`);
    const bad = issues({ MEZODOT_ENV: 'devnet', KEEPER_PRIVATE_KEY: `${KEY}ff` });
    expect(bad).toEqual(['KEEPER_PRIVATE_KEY must be a 32-byte hex private key (64 hex characters, optional 0x prefix)']);
    expect(bad.join(' ')).not.toContain(KEY);
    expect(loadConfig({ MEZODOT_ENV: 'devnet', KEEPER_PRIVATE_KEY: '' }).keeperKey).toBeNull(); // empty: read-only
  });

  it('rejects a short MCP token instead of serving /mcp without auth', () => {
    expect(issues({ MEZODOT_ENV: 'devnet', MCP_TOKEN: 'fifteen-chars-x' })).toEqual(['MCP_TOKEN must be at least 16 characters (leave it empty to disable)']);
    expect(loadConfig({ MEZODOT_ENV: 'devnet', MCP_TOKEN: 'a-long-random-test-token-123' }).mcpToken).toBe('a-long-random-test-token-123');
  });

  it('rejects unknown modules (AGENT_MODULES=liquidators used to disable the liquidator silently)', () => {
    expect(issues({ MEZODOT_ENV: 'devnet', AGENT_MODULES: 'relayer,liquidators' })).toEqual([
      'AGENT_MODULES unknown module(s) liquidators (expected relayer, liquidator, risk, http, oracle)',
    ]);
    expect(issues({ MEZODOT_ENV: 'devnet', AGENT_MODULES: ' , ' })[0]).toMatch(/lists no module/);
    expect([...loadConfig({ MEZODOT_ENV: 'devnet', AGENT_MODULES: 'http, oracle' }).modules]).toEqual(['http', 'oracle']);
  });

  it('parses comma-separated RPC fallbacks and refuses malformed URLs, naming only their host', () => {
    const c = loadConfig({ MEZODOT_ENV: 'testnet', RPC_MEZO_TESTNET: 'https://a.example/v2/KEY1, https://b.example/' });
    expect(c.rpc['mezo-testnet']).toEqual(['https://a.example/v2/KEY1', 'https://b.example']);
    const bad = issues({ MEZODOT_ENV: 'testnet', RPC_BASE_SEPOLIA: 'ftp://rpc.example/v2/KEY2' });
    expect(bad).toEqual(['RPC_BASE_SEPOLIA must be an http(s) URL (rpc.example)']);
    expect(bad.join(' ')).not.toContain('KEY2');
  });

  it('validates per-network gas minimums, flags, policies and URLs, and lists every problem at once', () => {
    expect(loadConfig({ MEZODOT_ENV: 'testnet', MIN_GAS_BALANCE_BASE_SEPOLIA: '0.5' }).minGasBalance['base-sepolia']).toBe(parseEther('0.5'));
    expect(loadConfig({ MEZODOT_ENV: 'devnet', MCP_ALLOW_WRITE: 'TRUE' }).mcpAllowWrite).toBe(true);
    const all = issues({
      MEZODOT_ENV: 'testnet',
      MIN_GAS_BALANCE_ETH_SEPOLIA: 'lots',
      MCP_ALLOW_WRITE: 'maybe',
      LIQUIDATE_UNSELLABLE: 'sell-anyway',
      ALERT_WEBHOOK_URL: 'not a url',
      MAX_SALE_DISCOUNT_BPS: '90000',
    });
    expect(all).toHaveLength(5);
    expect(all.join('\n')).toMatch(/MIN_GAS_BALANCE_ETH_SEPOLIA must be a decimal amount/);
    expect(all.join('\n')).toMatch(/MCP_ALLOW_WRITE must be true or false/);
    expect(all.join('\n')).toMatch(/LIQUIDATE_UNSELLABLE/);
    expect(all.join('\n')).toMatch(/ALERT_WEBHOOK_URL must be a URL/);
    expect(all.join('\n')).toMatch(/MAX_SALE_DISCOUNT_BPS must be at most 5000/);
  });

  it('describes the effective configuration without secrets', () => {
    const c = loadConfig({
      MEZODOT_ENV: 'testnet',
      KEEPER_PRIVATE_KEY: KEY,
      MCP_TOKEN: 'a-long-random-test-token-123',
      PYTH_API_KEY: 'pyth-secret-key',
      RPC_MEZO_TESTNET: 'https://rpc.example/v2/SECRET_API_KEY_123',
      ALERT_WEBHOOK_URL: 'https://hooks.example/services/T000/B000/XXXX',
    });
    const text = JSON.stringify(describeConfig(c));
    for (const secret of [KEY, 'a-long-random-test-token-123', 'pyth-secret-key', 'SECRET_API_KEY_123', 'XXXX']) expect(text).not.toContain(secret);
    expect(describeConfig(c)).toMatchObject({
      keeper: 'configured',
      mcp: { token: 'set' },
      pythPusher: 'on',
      alertWebhook: 'set',
      rpc: { 'mezo-testnet': ['rpc.example'] },
    });
  });

  it('knows which hosts only this machine can reach', () => {
    expect(['127.0.0.1', '127.0.0.53', 'localhost', '::1'].map(isLoopbackHost)).toEqual([true, true, true, true]);
    expect(['0.0.0.0', '10.0.0.5', 'agent.example.com'].map(isLoopbackHost)).toEqual([false, false, false]);
  });
});
