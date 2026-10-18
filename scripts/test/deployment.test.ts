import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { publicClient, rpcHosts, rpcUrls } from '../lib/deployment';

/** A JSON-RPC endpoint on localhost: `result(method)` answers, null makes it fail with HTTP 503. */
async function rpcServer(result: (method: string) => unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const value = result(method);
      if (value === null) res.writeHead(503).end('unavailable');
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: value }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('RPC_<NETWORK>', () => {
  it('reads one URL or a comma-separated list, as the agent does', () => {
    expect(rpcUrls('mezo-testnet', { RPC_MEZO_TESTNET: 'https://a.example/v1/KEY, https://b.example' })).toEqual([
      'https://a.example/v1/KEY',
      'https://b.example',
    ]);
    expect(rpcUrls('eth-sepolia', { RPC_ETH_SEPOLIA: 'https://only.example' })).toEqual(['https://only.example']);
  });

  it('falls back to the SDK default when unset or blank', () => {
    expect(rpcUrls('mezo-testnet', {})).toEqual(['https://rpc.test.mezo.org']);
    expect(rpcUrls('mezo-testnet', { RPC_MEZO_TESTNET: ' , ' })).toEqual(['https://rpc.test.mezo.org']);
  });

  it('shows hosts only: a URL can carry an API key', () => {
    expect(rpcHosts('mezo-testnet', { RPC_MEZO_TESTNET: 'https://a.example/v1/KEY,https://b.example:8545?key=secret' })).toBe('a.example, b.example:8545');
  });

  it('reads through the next URL of a list when the first one fails', async () => {
    const down = await rpcServer(() => null);
    const up = await rpcServer((method) => (method === 'eth_chainId' ? '0x7b7b' : null));
    servers.push(down.server, up.server);
    const client = publicClient('mezo-testnet', { RPC_MEZO_TESTNET: `${down.url},${up.url}` });
    expect(client.transport.type).toBe('fallback');
    expect(await client.getChainId()).toBe(31611);
  });

  it('keeps a plain transport for a single URL', () => {
    expect(publicClient('mezo-testnet', { RPC_MEZO_TESTNET: 'https://only.example' }).transport.type).toBe('http');
  });
});
