import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem';
import { spokeGatewayAbi } from '@mezodot/sdk';
import { SPOKES, type SpokeInfo } from '../chain/env';
import { QK, readError, useSpokeClients } from './hooks';

/**
 * Releases whose token transfer failed on delivery (SpokeGateway emits ReleaseDeferred): the hub has already
 * debited the account, so the gateway keeps the tokens as `claimable[recipient][token]` until the recipient
 * calls `claim(token, to)`.
 */

/** Tokens a spoke gateway accepts, with their decimals (as everywhere else in the app). */
const SPOKE_TOKENS = [
  ['WETH', 18],
  ['USDC', 6],
] as const;

export type SpokeClaim = { spoke: SpokeInfo; symbol: (typeof SPOKE_TOKENS)[number][0]; token: Address; decimals: number; amount: bigint };

/** Claims are read per spoke: one whose RPC fails is left out of `claims` with its reason in `errors`, without hiding the others. */
export type SpokeClaims = { claims: SpokeClaim[]; errors: Record<string, string> };

export async function readSpokeClaims(account: Address, spokes: readonly SpokeInfo[], clients: readonly (PublicClient | undefined)[]): Promise<SpokeClaims> {
  const claims: SpokeClaim[] = [];
  const errors: Record<string, string> = {};
  await Promise.all(
    spokes.map(async (spoke, i) => {
      const client = clients[i];
      if (!client || !spoke.deployment) return;
      const gateway = spoke.deployment.contracts.spokeGateway;
      try {
        const rows = await Promise.all(
          SPOKE_TOKENS.map(async ([symbol, decimals]) => {
            const token = spoke.deployment!.tokens[symbol];
            const amount = await client.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'claimable', args: [account, token] });
            return { spoke, symbol, token, decimals, amount };
          }),
        );
        claims.push(...rows.filter((r) => r.amount > 0n));
      } catch (err) {
        errors[spoke.name] = readError(err);
      }
    }),
  );
  // Stable order for the UI: spokes as configured, then tokens.
  claims.sort((a, b) => spokes.indexOf(a.spoke) - spokes.indexOf(b.spoke) || a.symbol.localeCompare(b.symbol));
  return { claims, errors };
}

export type ClaimRecipient = { to: Address; error: null } | { to: null; error: string };

/**
 * Where a deferred release is claimed to (SpokeGateway.claim(token, to)): the connected wallet while `input` is empty,
 * else the address typed, which must be a valid EVM address (all lowercase, or with a correct EIP-55 checksum) that
 * can hold the tokens. A release deferred because the token refuses the wallet itself (a blacklisted recipient) can
 * only be collected this way: a claim back to the wallet hits the same failing transfer.
 */
export function claimRecipient(input: string, { account, token, gateway }: { account: Address; token: Address; gateway: Address }): ClaimRecipient {
  const text = input.trim();
  if (text === '') return { to: account, error: null };
  if (!isAddress(text, { strict: false })) return { to: null, error: 'Enter an address: 0x followed by 40 hexadecimal characters' };
  // Mixed case carries an EIP-55 checksum: a mistyped or truncated copy fails it.
  if (!isAddress(text)) return { to: null, error: 'That address fails its checksum: copy it again' };
  const to = getAddress(text);
  if (isAddressEqual(to, zeroAddress)) return { to: null, error: 'The zero address cannot receive tokens' };
  if (isAddressEqual(to, token) || isAddressEqual(to, gateway)) {
    return { to: null, error: 'That is the token or the gateway contract itself: tokens sent there cannot be recovered' };
  }
  return { to, error: null };
}

export function useSpokeClaims() {
  const { address } = useAccount();
  const clients = useSpokeClients();
  return useQuery({
    queryKey: QK.claims(address),
    enabled: Boolean(address && SPOKES.some((s) => s.deployment)),
    refetchInterval: 30_000,
    queryFn: () => readSpokeClaims(address!, SPOKES, clients),
  });
}
