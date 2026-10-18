import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, useConfig, usePublicClient } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import { erc20Abi, type Address, type PublicClient } from 'viem';
import {
  PRICE_SYMBOLS,
  SOURCE_TAG,
  displayPrices,
  fetchOracleUpdate,
  leverageManagerAbi,
  positionSymbols,
  readOracle,
  readPosition,
  readProtocol,
  symbolForPriceKey,
  usablePrices,
  valuePosition,
  type OracleState,
  type OracleStatus,
  type PriceSymbol,
  type ProtocolState,
  type UsdPrices,
  tigrisRouterAbi,
} from '@mezodot/sdk';
import { AGENT_URL, ENV_NAME, HUB, SPOKES } from '../chain/env';
import { scanIncremental } from './incremental';

/** Query keys shared with the transaction runner, which invalidates them after each write. */
export const QK = {
  protocol: ['protocol'] as const,
  oracle: ['oracle'] as const,
  pullPrices: (symbols: string) => ['pullPrices', symbols] as const,
  position: (a?: Address) => ['position', a] as const,
  balances: (a?: Address) => ['balances', a] as const,
  loopStats: ['loopStats'] as const,
  activity: (a?: Address) => ['activity', a] as const,
  agent: (path: string) => ['agent', path] as const,
  tigrisQuote: (from?: Address, to?: Address, amount?: string) => ['tigrisQuote', from, to, amount] as const,
};

export const useHubClient = () => usePublicClient({ chainId: HUB.chain.id }) as PublicClient | undefined;

/** Public clients for every spoke, index-aligned with SPOKES. */
export function useSpokeClients(): (PublicClient | undefined)[] {
  const config = useConfig();
  return SPOKES.map((s) => getPublicClient(config, { chainId: s.chain.id }) as PublicClient | undefined);
}

/**
 * Tigris DEX quote: output of swapping `amountIn` of `from` into `to` on the volatile pool the BTC leverage uses.
 * Undefined until loaded or when Tigris is not configured.
 */
export function useTigrisQuote(from: Address | undefined, to: Address | undefined, amountIn: bigint) {
  const client = useHubClient();
  const router = HUB.deployment?.contracts.tigrisRouter;
  const factory = HUB.deployment?.contracts.tigrisFactory;
  return useQuery({
    queryKey: QK.tigrisQuote(from, to, amountIn.toString()),
    enabled: Boolean(client && router && factory && from && to && amountIn > 0n),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<bigint> => {
      const amounts = await client!.readContract({
        address: router!,
        abi: tigrisRouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, [{ from: from!, to: to!, stable: false, factory: factory! }]],
      });
      return amounts[amounts.length - 1];
    },
  });
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

/** Router state: feeds, strict availability and last stored prices. */
export function useOracle() {
  const client = useHubClient();
  return useQuery({
    queryKey: QK.oracle,
    enabled: Boolean(client && HUB.deployment),
    queryFn: () => readOracle(client!, HUB.deployment!),
    refetchInterval: 12_000,
  });
}

/** Keys the agent relay can refresh: Supra legs everywhere; on the devnet the mocked Pyth legs too. */
const isPullable = (s: OracleStatus) =>
  [s.feed?.primary, s.feed?.secondary].some((l) => l?.source === SOURCE_TAG.SUPRA) || (ENV_NAME === 'devnet' && s.feed?.primary.source === SOURCE_TAG.PYTH);

export type Prices = {
  oracle: OracleState;
  /** Prices VaultManager accepts now (strict on-chain, else a fresh pull price): use for limits and previews. */
  usable: UsdPrices;
  /** Usable prices, falling back to the last stored values: use for display only. */
  prices: UsdPrices;
  /** Newest publish time among usable prices (unix seconds). */
  publishTime: number;
  /** Why fresh pull prices are missing (agent relay unreachable), if they are. */
  relayError: string | null;
};

/**
 * Prices for the UI. Keys not usable on-chain (e.g. ETH, whose Supra proof is only posted with a
 * transaction) are previewed with fresh prices from the agent relay; the browser never calls Hermes.
 */
export function usePrices(): { data: Prices | undefined; isLoading: boolean } {
  const oracle = useOracle();
  const pull = oracle.data ? PRICE_SYMBOLS.filter((s) => !oracle.data![s].ok && isPullable(oracle.data![s])) : [];
  const fresh = useQuery({
    queryKey: QK.pullPrices(pull.join(',')),
    enabled: pull.length > 0,
    queryFn: () => fetchOracleUpdate(AGENT_URL, pull),
    refetchInterval: 15_000,
    retry: false,
  });
  const data = useMemo((): Prices | undefined => {
    if (!oracle.data) return undefined;
    const freshPrices = pull.length > 0 ? fresh.data?.prices : undefined;
    const times = PRICE_SYMBOLS.map((s) => (oracle.data![s].ok ? oracle.data![s].publishTime : (freshPrices?.[s]?.publishTime ?? 0)));
    return {
      oracle: oracle.data,
      usable: usablePrices(oracle.data, freshPrices),
      prices: displayPrices(oracle.data, freshPrices),
      publishTime: Math.max(0, ...times),
      relayError: pull.length > 0 && fresh.error ? (fresh.error instanceof Error ? fresh.error.message : String(fresh.error)) : null,
    };
    // `pull` is derived from oracle.data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracle.data, fresh.data, fresh.error]);
  return { data, isLoading: oracle.isLoading };
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

/**
 * Position valued with the prices VaultManager would accept now, so limits and MAX amounts match the
 * contract (the on-chain snapshot uses last stored prices, which may be stale for pull feeds).
 * `unpriced` lists held assets without an acceptable price: they count as zero toward borrowing.
 */
export function useValuedPosition() {
  const protocol = useProtocol();
  const prices = usePrices();
  const position = usePosition();
  const usable = prices.data?.usable;
  const valued = protocol.data && position.data && usable ? valuePosition(protocol.data, position.data, usable) : null;
  const unpriced = protocol.data && position.data && usable ? positionSymbols(protocol.data, position.data).filter((s) => usable[s] === undefined) : [];
  return {
    valued,
    position: position.data,
    protocol: protocol.data,
    prices: usable,
    unpriced,
    relayError: prices.data?.relayError ?? null,
    isLoading: position.isLoading || protocol.isLoading,
  };
}

export type WalletBalances = {
  hub: { native: bigint; tokens: Record<string, bigint> };
  /** Per spoke: native ETH, token balances, and the gas price (to keep ETH back for fees when wrapping). */
  spokes: Record<string, { native: bigint; WETH: bigint; USDC: bigint; gasPrice: bigint }>;
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
      await Promise.all([
        ...protocol.data!.markets.flatMap((m) => [
          bal(hubClient!, m.asset).then((v) => (tokens[m.symbol] = v)),
          bal(hubClient!, m.pool).then((v) => (tokens[m.receiptSymbol] = v)),
        ]),
        // Plain hub collateral (BTC) is held as the token itself.
        ...protocol.data!.collaterals.filter((c) => !c.isRemote && !c.isShare).map((c) => bal(hubClient!, c.token).then((v) => (tokens[c.symbol] = v))),
      ]);
      const native = await hubClient!.getBalance({ address: address! }).catch(() => 0n);
      const spokes: WalletBalances['spokes'] = {};
      await Promise.all(
        SPOKES.map(async (s, i) => {
          const c = spokeClients[i];
          if (!c || !s.deployment) return;
          const [n, weth, usdc, gasPrice] = await Promise.all([
            c.getBalance({ address: address! }).catch(() => 0n),
            bal(c, s.deployment.tokens.WETH),
            bal(c, s.deployment.tokens.USDC),
            c.getGasPrice().catch(() => 0n),
          ]);
          spokes[s.name] = { native: n, WETH: weth, USDC: usdc, gasPrice };
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
      const logs = await scanIncremental(
        'loops',
        BigInt(HUB.deployment!.startBlock),
        latest,
        (range) => client!.getContractEvents({ address: HUB.deployment!.contracts.leverageManager, abi: leverageManagerAbi, eventName: 'Looped', ...range }),
        HUB.maxLogRange,
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
