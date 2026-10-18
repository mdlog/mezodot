import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { Address, PublicClient } from 'viem';
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
