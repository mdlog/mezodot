import { describe, expect, it, vi } from 'vitest';
import { HttpRequestError, getAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { SPOKES } from '../chain/env';
import { claimRecipient, readSpokeClaims } from './claims';

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

describe('claiming a deferred release to another address (final review WEB-2)', () => {
  const [spoke] = spokes;
  const ctx = { account: ACCOUNT, token: spoke.deployment!.tokens.USDC, gateway: spoke.deployment!.contracts.spokeGateway };
  const ELSEWHERE = getAddress('0x52908400098527886e0f7030069857d2e4169ee7');

  it('claims to the wallet until another address is entered', () => {
    expect(claimRecipient('', ctx)).toEqual({ to: ACCOUNT, error: null });
    expect(claimRecipient('   ', ctx)).toEqual({ to: ACCOUNT, error: null });
  });

  it('accepts an address in lowercase or with its checksum, and sends to it checksummed', () => {
    expect(claimRecipient(ELSEWHERE, ctx)).toEqual({ to: ELSEWHERE, error: null });
    expect(claimRecipient(` ${ELSEWHERE.toLowerCase()} `, ctx)).toEqual({ to: ELSEWHERE, error: null });
  });

  it('refuses what is not an address, a broken checksum, and addresses that cannot pass the tokens on', () => {
    expect(claimRecipient('0x1234', ctx).error).toMatch(/0x followed by 40 hexadecimal characters/);
    expect(claimRecipient('vitalik.eth', ctx).error).toMatch(/0x followed by 40/);
    // One letter's case changed: the EIP-55 checksum no longer matches.
    const mistyped = ELSEWHERE.replace('E', 'e');
    expect(mistyped).not.toBe(ELSEWHERE);
    expect(claimRecipient(mistyped, ctx)).toEqual({ to: null, error: 'That address fails its checksum: copy it again' });
    expect(claimRecipient(zeroAddress, ctx).error).toMatch(/zero address/);
    expect(claimRecipient(ctx.token.toLowerCase(), ctx).error).toMatch(/token or the gateway contract/);
    expect(claimRecipient(ctx.gateway, ctx).error).toMatch(/token or the gateway contract/);
  });
});
