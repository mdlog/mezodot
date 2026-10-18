import { describe, expect, it, vi } from 'vitest';
import { HttpRequestError, type Address, type PublicClient } from 'viem';
import { SPOKES } from '../chain/env';
import { readSpokeClaims } from './claims';

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';
const spokes = SPOKES.filter((s) => s.deployment);

/** A spoke client whose gateway reports `claimable` per token address. */
const clientWith = (claimable: Record<string, bigint>) =>
  ({
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: [Address, Address] }) => {
      if (functionName !== 'claimable') throw new Error(`unexpected read ${functionName}`);
      return claimable[args[1].toLowerCase()] ?? 0n;
    }),
  }) as unknown as PublicClient;

describe('claimable releases (SpokeGateway ReleaseDeferred)', () => {
  it('lists only tokens with something to claim, with their decimals', async () => {
    const [spoke] = spokes;
    const usdc = spoke.deployment!.tokens.USDC;
    const { claims, errors } = await readSpokeClaims(ACCOUNT, [spoke], [clientWith({ [usdc.toLowerCase()]: 2_500_000n })]);
    expect(errors).toEqual({});
    expect(claims).toEqual([{ spoke, symbol: 'USDC', token: usdc, decimals: 6, amount: 2_500_000n }]);
  });

  it('reads the connected account’s claims on every spoke', async () => {
    const client = clientWith({});
    await readSpokeClaims(
      ACCOUNT,
      spokes,
      spokes.map(() => client),
    );
    const calls = vi.mocked(client.readContract).mock.calls.map(([c]) => c as unknown as { address: Address; args: [Address, Address] });
    expect(calls).toHaveLength(spokes.length * 2);
    expect(calls.every((c) => c.args[0] === ACCOUNT)).toBe(true);
    expect(new Set(calls.map((c) => c.address))).toEqual(new Set(spokes.map((s) => s.deployment!.contracts.spokeGateway)));
  });

  it('reports a spoke whose RPC fails instead of showing nothing to claim', async () => {
    const [spoke] = spokes;
    const failing = {
      readContract: vi.fn().mockRejectedValue(new HttpRequestError({ url: 'https://sepolia.base.org', status: 429 })),
    } as unknown as PublicClient;
    const { claims, errors } = await readSpokeClaims(ACCOUNT, [spoke], [failing]);
    expect(claims).toEqual([]);
    expect(errors[spoke.name]).toMatch(/HTTP 429 from sepolia\.base\.org/);
  });

  it('skips spokes without a client', async () => {
    expect(await readSpokeClaims(ACCOUNT, spokes, [])).toEqual({ claims: [], errors: {} });
  });
});
