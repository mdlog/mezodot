import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, useConfig, usePublicClient } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import { BaseError, HttpRequestError, erc20Abi, type Address, type PublicClient } from 'viem';
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
  swapLeverageManagerAbi,
  usablePrices,
  valuePosition,
  type OracleState,
  type OracleStatus,
  type ProtocolState,
  type UsdPrices,
  tigrisPoolAbi,
} from '@mezodot/sdk';
import { AGENT_URL, ENV_NAME, HUB, SPOKES } from '../chain/env';
import { explainError } from '../lib/errors';
import { protocolTotals } from '../lib/tvl';
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
  claims: (a?: Address) => ['claims', a] as const,
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

/** One line for a failed read: the revert or RPC message, with the HTTP status when an endpoint refused. */
export function readError(err: unknown): string {
  const http = err instanceof BaseError ? (err.walk((e) => e instanceof HttpRequestError) as HttpRequestError | null) : null;
  const message = explainError(err).replace(/\.$/, '');
  return http?.status ? `${message} (HTTP ${http.status} from ${new URL(http.url).host})` : message;
}

/**
 * Whether the hub contracts can be read. Everything else waits on this read, so pages show `error` (with a
 * retry) instead of loading forever when the RPC is down or the deployment does not match the SDK.
 */
export function useHubStatus() {
  const protocol = useProtocol();
  const oracle = useOracle();
  const queryClient = useQueryClient();
  const failed = protocol.error ?? oracle.error;
  const retry = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: QK.protocol });
    void queryClient.refetchQueries({ queryKey: QK.oracle });
  }, [queryClient]);
  return {
    /** Why the hub cannot be read right now, if it cannot. */
    error: failed ? readError(failed) : null,
    /** The first read is still running. */
    loading: Boolean(HUB.deployment) && protocol.data === undefined && !protocol.error,
    /** Values on screen come from an earlier read: the latest refresh failed. */
    stale: Boolean(failed && protocol.data),
    retrying: protocol.isFetching || oracle.isFetching,
    retry,
  };
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
 * `unpriced` lists held assets without an acceptable price: collateral counts as zero toward borrowing.
 * `unpricedDebts` lists debts without one: every borrow, collateral withdrawal and loop reverts until the price is
 * fresh (debt is priced strictly). Both are valued at the last stored price for value and health, as the risk
 * snapshot does, so a lapsed feed shows neither "no debt" nor a collapse of the collateral.
 * `valued` is null until prices load; with debt, limits are unknown until then.
 */
export function useValuedPosition() {
  const protocol = useProtocol();
  const prices = usePrices();
  const position = usePosition();
  const usable = prices.data?.usable;
  const valued = protocol.data && position.data && usable ? valuePosition(protocol.data, position.data, usable, { fallbackPrices: prices.data?.prices }) : null;
  const unpriced = protocol.data && position.data && usable ? positionSymbols(protocol.data, position.data).filter((s) => usable[s] === undefined) : [];
  return {
    valued,
    position: position.data,
    protocol: protocol.data,
    prices: usable,
    unpriced,
    unpricedDebts: valued?.unpricedDebts ?? [],
    /** No debt in any market, read from the position itself: collateral may then leave without any price. */
    debtFree: position.data ? position.data.debts.every((d) => d.amount === 0n) : false,
    relayError: prices.data?.relayError ?? null,
    isLoading: position.isLoading || protocol.isLoading,
  };
}

/** One spoke's wallet: native ETH, token balances, and the gas price (to keep ETH back for fees when wrapping). */
export type SpokeBalances = { native: bigint; WETH: bigint; USDC: bigint; gasPrice: bigint };

/**
 * Wallet balances. A read that fails is unknown, never zero: a hub failure fails the whole query (react-query
 * keeps the last good values and retries), and a spoke whose RPC fails is left out of `spokes` with its reason in
 * `spokeErrors`, so one rate-limited spoke does not hide the others.
 */
export type WalletBalances = {
  hub: { native: bigint; tokens: Record<string, bigint> };
  spokes: Record<string, SpokeBalances>;
  spokeErrors: Record<string, string>;
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
      const bal = (client: PublicClient, token: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address!] });
      const tokens: Record<string, bigint> = {};
      const [native] = await Promise.all([
        hubClient!.getBalance({ address: address! }),
        ...protocol.data!.markets.flatMap((m) => [
          bal(hubClient!, m.asset).then((v) => (tokens[m.symbol] = v)),
          bal(hubClient!, m.pool).then((v) => (tokens[m.receiptSymbol] = v)),
        ]),
        // Plain hub collateral (BTC) is held as the token itself.
        ...protocol.data!.collaterals.filter((c) => !c.isRemote && !c.isShare).map((c) => bal(hubClient!, c.token).then((v) => (tokens[c.symbol] = v))),
      ]);
      const spokes: WalletBalances['spokes'] = {};
      const spokeErrors: WalletBalances['spokeErrors'] = {};
      await Promise.all(
        SPOKES.map(async (s, i) => {
          const c = spokeClients[i];
          if (!c || !s.deployment) return;
          try {
            const [n, weth, usdc, gasPrice] = await Promise.all([
              c.getBalance({ address: address! }),
              bal(c, s.deployment.tokens.WETH),
              bal(c, s.deployment.tokens.USDC),
              c.getGasPrice(),
            ]);
            spokes[s.name] = { native: n, WETH: weth, USDC: usdc, gasPrice };
          } catch (err) {
            spokeErrors[s.name] = readError(err);
          }
        }),
      );
      return { hub: { native, tokens }, spokes, spokeErrors };
    },
  });
}

/** One-transaction positions opened so far, with their gross size (what was put to work, not the equity). */
export type LoopStats = {
  /** LeverageManager loops and their gross MUSD (principal × leverage), 18 decimals. */
  musdLoops: number;
  musdVolume: bigint;
  /** SwapLeverageManager BTC positions and their gross BTC (principal + bought), 18 decimals. */
  btcPositions: number;
  btcVolume: bigint;
};

const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);

/** Lifetime leverage volume from LeverageManager `Looped` and SwapLeverageManager `Opened` events. */
export function useLoopStats() {
  const client = useHubClient();
  return useQuery({
    queryKey: QK.loopStats,
    enabled: Boolean(client && HUB.deployment),
    refetchInterval: 30_000,
    queryFn: async (): Promise<LoopStats> => {
      const dep = HUB.deployment!;
      const latest = await client!.getBlockNumber();
      const start = BigInt(dep.startBlock);
      const slm = dep.contracts.swapLeverageManager;
      const [loops, opens] = await Promise.all([
        scanIncremental(
          `${ENV_NAME}:loops:${dep.contracts.leverageManager}`,
          start,
          latest,
          async (range) =>
            (await client!.getContractEvents({ address: dep.contracts.leverageManager, abi: leverageManagerAbi, eventName: 'Looped', ...range })).map(
              (l) => (l.args.principal! * l.args.leverage!) / 10n ** 18n,
            ),
          HUB.maxLogRange,
          { persist: true },
        ),
        slm
          ? scanIncremental(
              `${ENV_NAME}:opens:${slm}`,
              start,
              latest,
              async (range) =>
                (await client!.getContractEvents({ address: slm, abi: swapLeverageManagerAbi, eventName: 'Opened', ...range })).map(
                  (l) => l.args.principal! + l.args.bought!,
                ),
              HUB.maxLogRange,
              { persist: true },
            )
          : Promise.resolve([] as bigint[]),
      ]);
      return { musdLoops: loops.length, musdVolume: sum(loops), btcPositions: opens.length, btcVolume: sum(opens) };
    },
  });
}

/** Gross USD opened through both leverage products, at display prices (MUSD defaults to $1). */
export const loopVolumeUsd = (stats: LoopStats, prices: UsdPrices | undefined): number =>
  (Number(stats.musdVolume) / 1e18) * (prices?.MUSD ?? 1) + (Number(stats.btcVolume) / 1e18) * (prices?.BTC ?? 0);

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

/**
 * Total value locked in USD, net of borrows: idle pool cash, BTC posted on the hub and collateral locked on
 * spokes (see protocolTotals, which also reports supplied and borrowed).
 */
export function computeTvl(protocol: ProtocolState, prices: UsdPrices): number {
  return protocolTotals(protocol, prices).tvl;
}

/**
 * Output of selling `amountIn` of `tokenIn` on the Tigris MUSD/BTC pool SwapLeverageManager trades with
 * (contracts.tigrisPool): pair.getAmountOut, the very quote open and close execute at. Undefined until loaded, for a
 * zero amount, and on deployments without the pool.
 */
export function useTigrisPoolQuote(tokenIn: Address | undefined, amountIn: bigint) {
  const client = useHubClient();
  const pool = HUB.deployment?.contracts.tigrisPool;
  return useQuery({
    queryKey: ['tigrisPoolQuote', pool, tokenIn, amountIn.toString()] as const,
    enabled: Boolean(client && pool && tokenIn && amountIn > 0n),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: () => client!.readContract({ address: pool!, abi: tigrisPoolAbi, functionName: 'getAmountOut', args: [amountIn, tokenIn!] }),
  });
}
