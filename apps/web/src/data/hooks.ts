import { useQuery } from '@tanstack/react-query';
import { useAccount, useConfig, usePublicClient } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import { erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import {
  fetchPriceUpdate,
  leverageManagerAbi,
  pricesBySymbol,
  readPosition,
  readProtocol,
  symbolForPriceKey,
  valuePosition,
  type PriceSymbol,
  type ProtocolState,
  type UsdPrices,
} from '@mezodot/sdk';
import { AGENT_URL, HUB, SPOKES } from '../chain/env';
import { scanIncremental } from './incremental';

/** Query keys shared with the transaction runner, which invalidates them after each write. */
export const QK = {
  protocol: ['protocol'] as const,
  prices: ['prices'] as const,
  position: (a?: Address) => ['position', a] as const,
  balances: (a?: Address) => ['balances', a] as const,
  loopStats: ['loopStats'] as const,
  activity: (a?: Address) => ['activity', a] as const,
  agent: (path: string) => ['agent', path] as const,
};

export const useHubClient = () => usePublicClient({ chainId: HUB.chain.id }) as PublicClient | undefined;

/** Public clients for every spoke, index-aligned with SPOKES. */
export function useSpokeClients(): (PublicClient | undefined)[] {
  const config = useConfig();
  return SPOKES.map((s) => getPublicClient(config, { chainId: s.chain.id }) as PublicClient | undefined);
}

export function useProtocol() {
  const client = useHubClient();
  return useQuery({
    queryKey: QK.protocol,
    enabled: Boolean(client && HUB.deployment),
    queryFn: () => readProtocol(client!, HUB.deployment!),
    refetchInterval: 12_000,
  });
}

/** Fresh Pyth prices for previews (and the update bytes for the next risk-checked tx). */
export function usePrices() {
  return useQuery({
    queryKey: QK.prices,
    enabled: Boolean(HUB.deployment),
    queryFn: async () => {
      const feeds = HUB.deployment!.priceFeeds;
      const update = await fetchPriceUpdate(HUB.hermesUrl, Object.values(feeds) as Hex[]);
      return { prices: pricesBySymbol(feeds, update.prices) as UsdPrices, publishTime: Math.max(0, ...Object.values(update.prices).map((p) => p.publishTime)) };
    },
    refetchInterval: 15_000,
  });
}

export function usePosition() {
  const client = useHubClient();
  const { address } = useAccount();
  const protocol = useProtocol();
  return useQuery({
    queryKey: QK.position(address),
    enabled: Boolean(client && HUB.deployment && address && protocol.data),
    queryFn: () => readPosition(client!, HUB.deployment!, protocol.data!, address!),
    refetchInterval: 12_000,
  });
}

/** Position valued with fresh prices (the on-chain snapshot may use stale pull-oracle prices). */
export function useValuedPosition() {
  const protocol = useProtocol();
  const prices = usePrices();
  const position = usePosition();
  const valued = protocol.data && position.data && prices.data ? valuePosition(protocol.data, position.data, prices.data.prices) : null;
  return { valued, position: position.data, protocol: protocol.data, prices: prices.data?.prices, isLoading: position.isLoading || protocol.isLoading };
}

export type WalletBalances = {
  hub: { native: bigint; tokens: Record<string, bigint> };
  spokes: Record<string, { native: bigint; WETH: bigint; USDC: bigint }>;
};

export function useWalletBalances() {
  const { address } = useAccount();
  const hubClient = useHubClient();
  const spokeClients = useSpokeClients();
  const protocol = useProtocol();
  return useQuery({
    queryKey: QK.balances(address),
    enabled: Boolean(address && hubClient && protocol.data),
    refetchInterval: 15_000,
    queryFn: async (): Promise<WalletBalances> => {
      const bal = (client: PublicClient, token: Address) =>
        client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address!] }).catch(() => 0n);
      const tokens: Record<string, bigint> = {};
      await Promise.all(
        protocol.data!.markets.flatMap((m) => [
          bal(hubClient!, m.asset).then((v) => (tokens[m.symbol] = v)),
          bal(hubClient!, m.pool).then((v) => (tokens[m.receiptSymbol] = v)),
        ]),
      );
      const native = await hubClient!.getBalance({ address: address! }).catch(() => 0n);
      const spokes: WalletBalances['spokes'] = {};
      await Promise.all(
        SPOKES.map(async (s, i) => {
          const c = spokeClients[i];
          if (!c || !s.deployment) return;
          const [n, weth, usdc] = await Promise.all([
            c.getBalance({ address: address! }).catch(() => 0n),
            bal(c, s.deployment.tokens.WETH),
            bal(c, s.deployment.tokens.USDC),
          ]);
          spokes[s.name] = { native: n, WETH: weth, USDC: usdc };
        }),
      );
      return { hub: { native, tokens }, spokes };
    },
  });
}

/** Lifetime looping volume (gross position opened) from LeverageManager events. */
export function useLoopStats() {
  const client = useHubClient();
  return useQuery({
    queryKey: QK.loopStats,
    enabled: Boolean(client && HUB.deployment),
    refetchInterval: 30_000,
    queryFn: async () => {
      const latest = await client!.getBlockNumber();
      const logs = await scanIncremental('loops', BigInt(HUB.deployment!.startBlock), latest, (range) =>
        client!.getContractEvents({ address: HUB.deployment!.contracts.leverageManager, abi: leverageManagerAbi, eventName: 'Looped', ...range }),
      );
      const volume = logs.reduce((s, l) => s + (l.args.principal! * l.args.leverage!) / 10n ** 18n, 0n);
      return { loops: logs.length, volume };
    },
  });
}

/** Optional data from the Mezodot agent; resolves to null when the agent is unreachable. */
export function useAgent<T>(path: string, refetchInterval = 30_000) {
  return useQuery({
    queryKey: QK.agent(path),
    refetchInterval,
    retry: false,
    queryFn: async (): Promise<T | null> => {
      try {
        const res = await fetch(`${AGENT_URL}${path}`);
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    },
  });
}

/** Total value locked in USD: hub pools + collateral posted on spokes. */
export function computeTvl(protocol: ProtocolState, prices: UsdPrices): number {
  let tvl = 0;
  for (const m of protocol.markets) tvl += (Number(m.totalAssets) / 10 ** m.decimals) * (prices[m.symbol as PriceSymbol] ?? 0);
  for (const c of protocol.collaterals) {
    if (!c.isRemote) continue;
    const symbol = symbolForPriceKey(c.priceKey);
    tvl += (Number(c.total) / 10 ** c.decimals) * (symbol ? (prices[symbol] ?? 0) : 0);
  }
  return tvl;
}
