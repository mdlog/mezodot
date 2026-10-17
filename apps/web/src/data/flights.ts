import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Hex, PublicClient } from 'viem';
import { NETWORKS, fetchSignedVaa, spokeGatewayAbi, vaaDigest, wormholeAdapterAbi } from '@mezodot/sdk';
import { AGENT_URL, HUB, SPOKES } from '../chain/env';
import type { Flight } from '../state/UiContext';

export type FlightStatus = {
  /** 1 locked/sent on source · 2 guardians signed (VAA) · 3 delivered on target · 4 usable */
  stage: 1 | 2 | 3 | 4;
  vaa: Hex | null;
  delivered: boolean;
  /** Who is expected to deliver: the agent relayer or the user (self-relay). */
  relayer: string | null;
};

type AgentMessage = { id: string; status: string };

/**
 * Tracks one Wormhole message: VAA availability from Wormholescan (testnet) or the agent (devnet,
 * where VAAs are signed locally), and delivery via the target contract's replay guard.
 */
export function useFlightStatus(flight: Flight) {
  const target = flight.target === HUB.name ? HUB : SPOKES.find((s) => s.name === flight.target);
  const targetClient = usePublicClient({ chainId: target?.chain.id }) as PublicClient | undefined;
  const api = NETWORKS[flight.source].wormholescanApi;

  return useQuery({
    queryKey: ['flight', flight.id],
    refetchInterval: (q) => (q.state.data?.delivered ? false : 6_000),
    enabled: Boolean(targetClient && target),
    queryFn: async (): Promise<FlightStatus> => {
      let vaa: Hex | null = null;
      let agentStatus: string | null = null;
      if (api) {
        vaa = await fetchSignedVaa(api, flight.emitterChain, flight.emitter, BigInt(flight.sequence)).catch(() => null);
      } else {
        // Devnet: the agent signs VAAs; ask it for the message status.
        const res = await fetch(`${AGENT_URL}/messages`).catch(() => null);
        const messages = res?.ok ? ((await res.json()) as AgentMessage[]) : [];
        agentStatus = messages.find((m) => m.id === `${flight.emitterChain}/${flight.emitter.toLowerCase()}/${flight.sequence}`)?.status ?? null;
      }

      let delivered = agentStatus === 'delivered';
      if (vaa && targetClient && target) {
        const digest = vaaDigest(vaa);
        delivered =
          flight.direction === 'deposit'
            ? await targetClient.readContract({
                address: HUB.deployment!.contracts.wormholeAdapter,
                abi: wormholeAdapterAbi,
                functionName: 'isConsumed',
                args: [digest],
              })
            : await targetClient.readContract({
                address: SPOKES.find((s) => s.name === flight.target)!.deployment!.contracts.spokeGateway,
                abi: spokeGatewayAbi,
                functionName: 'isConsumed',
                args: [digest],
              });
      }
      const signed = Boolean(vaa) || agentStatus === 'ready' || delivered;
      return { stage: delivered ? 4 : signed ? 2 : 1, vaa, delivered, relayer: api ? 'Mezodot agent or you (self-relay)' : 'Mezodot agent (devnet)' };
    },
  });
}
