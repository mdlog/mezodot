import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { Abi, Address, Hex, PublicClient } from 'viem';
import {
  leverageManagerAbi,
  pTokenAbi,
  spokeGatewayAbi,
  swapLeverageManagerAbi,
  vaultManagerAbi,
  type BlockRange,
  type CollateralState,
  type NetworkName,
  type ProtocolState,
} from '@mezodot/sdk';
import { ENV_NAME, HUB, SPOKES, spokeByWormholeChain } from '../chain/env';
import { fmt, units } from '../lib/format';
import { QK, readError, useHubClient, useProtocol, useSpokeClients } from './hooks';
import { scanIncremental, spokeHistoryStart } from './incremental';

export type ActivityKind =
  'Supply' | 'Withdraw' | 'Collateral in' | 'Collateral out' | 'Cross-chain' | 'Release' | 'Borrow' | 'Repay' | 'Loop' | 'Unwind' | 'Liquidation';

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  network: NetworkName;
  asset: string;
  amount: bigint;
  decimals: number;
  detail: string;
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number | null;
  /** The Wormhole message the event sent (spoke locks, hub releases), so a lost flight can be rebuilt. */
  message?: { direction: 'deposit' | 'release'; target: NetworkName; emitterChain: number; emitter: Address; sequence: string; label: string };
};

const timestamps = new Map<string, number>();
async function withTimestamps(client: PublicClient, network: NetworkName, items: ActivityItem[]): Promise<ActivityItem[]> {
  const blocks = [...new Set(items.map((i) => i.blockNumber))];
  await Promise.all(
    blocks.map(async (b) => {
      const key = `${network}:${b}`;
      if (!timestamps.has(key)) timestamps.set(key, Number((await client.getBlock({ blockNumber: b })).timestamp) * 1000);
    }),
  );
  for (const i of items) i.timestamp = timestamps.get(`${network}:${i.blockNumber}`) ?? null;
  return items;
}

/** Units of a posted collateral amount: pool shares for pTokens (pMUSD: 24 decimals), token units otherwise. */
export function collateralUnits(protocol: ProtocolState, c: CollateralState): { symbol: string; decimals: number } {
  const market = c.isShare ? protocol.markets.find((m) => m.pool.toLowerCase() === c.token.toLowerCase()) : undefined;
  return market ? { symbol: market.receiptSymbol, decimals: market.shareDecimals } : { symbol: c.symbol, decimals: c.decimals };
}

/** VaultManager.repayWithCollateral exists from the v4 hub on; its event is read only when the ABI has it. */
const HAS_REPAID_WITH_COLLATERAL = (vaultManagerAbi as Abi).some((x) => x.type === 'event' && x.name === 'RepaidWithCollateral');

async function hubActivity(client: PublicClient, protocol: ProtocolState, account: Address, range: BlockRange): Promise<ActivityItem[]> {
  const dep = HUB.deployment!;
  const vm = dep.contracts.vaultManager;
  const items: ActivityItem[] = [];
  const push = (i: Omit<ActivityItem, 'id' | 'network' | 'timestamp'> & { logIndex: number }) => {
    const { logIndex, ...item } = i;
    items.push({ ...item, id: `${i.txHash}-${logIndex}`, network: HUB.name, timestamp: null });
  };
  const collat = (id: bigint) => protocol.collaterals[Number(id)];
  const market = (id: bigint) => protocol.markets[Number(id)];

  const slm = dep.contracts.swapLeverageManager;
  const [poolDeposits, poolWithdraws, cIn, cOut, credited, releases, borrows, repays, loops, unwinds, liqs, opened, closed, repaidWithShares] =
    await Promise.all([
      Promise.all(
        protocol.markets.map((m) =>
          client
            .getContractEvents({ address: m.pool, abi: pTokenAbi, eventName: 'Deposit', args: { owner: account }, ...range })
            .then((l) => l.map((x) => ({ x, m }))),
        ),
      ),
      Promise.all(
        protocol.markets.map((m) =>
          client
            .getContractEvents({ address: m.pool, abi: pTokenAbi, eventName: 'Withdraw', args: { owner: account }, ...range })
            .then((l) => l.map((x) => ({ x, m }))),
        ),
      ),
      client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'CollateralDeposited', args: { account }, ...range }),
      client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'CollateralWithdrawn', args: { account }, ...range }),
      client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'RemoteCredited', args: { account }, ...range }),
      client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'RemoteWithdrawRequested', args: { account }, ...range }),
      client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'Borrowed', args: { account }, ...range }),
      client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'Repaid', args: { account }, ...range }),
      client.getContractEvents({ address: dep.contracts.leverageManager, abi: leverageManagerAbi, eventName: 'Looped', args: { account }, ...range }),
      client.getContractEvents({ address: dep.contracts.leverageManager, abi: leverageManagerAbi, eventName: 'Unwound', args: { account }, ...range }),
      client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'Liquidated', args: { account }, ...range }),
      slm ? client.getContractEvents({ address: slm, abi: swapLeverageManagerAbi, eventName: 'Opened', args: { account }, ...range }) : Promise.resolve([]),
      slm ? client.getContractEvents({ address: slm, abi: swapLeverageManagerAbi, eventName: 'Closed', args: { account }, ...range }) : Promise.resolve([]),
      HAS_REPAID_WITH_COLLATERAL
        ? (client.getContractEvents({
            address: vm,
            abi: vaultManagerAbi as Abi,
            eventName: 'RepaidWithCollateral',
            args: { account },
            ...range,
          }) as Promise<{ args: { marketId?: bigint; collateralId?: bigint; repaid?: bigint }; transactionHash: Hex; blockNumber: bigint; logIndex: number }[]>)
        : Promise.resolve([]),
    ]);

  for (const { x, m } of poolDeposits.flat())
    push({
      kind: 'Supply',
      asset: m.symbol,
      amount: x.args.assets!,
      decimals: m.decimals,
      detail: `Minted ${m.receiptSymbol}`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const { x, m } of poolWithdraws.flat())
    push({
      kind: 'Withdraw',
      asset: m.symbol,
      amount: x.args.assets!,
      decimals: m.decimals,
      detail: `Redeemed ${m.receiptSymbol}`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const [kind, logs, detail] of [
    ['Collateral in', cIn, 'Posted to VaultManager'],
    ['Collateral out', cOut, 'Withdrawn from VaultManager'],
  ] as const)
    for (const x of logs) {
      const unit = collateralUnits(protocol, collat(x.args.id!));
      push({
        kind,
        asset: unit.symbol,
        amount: x.args.amount!,
        decimals: unit.decimals,
        detail,
        txHash: x.transactionHash,
        blockNumber: x.blockNumber,
        logIndex: x.logIndex,
      });
    }
  for (const x of credited)
    push({
      kind: 'Cross-chain',
      asset: collat(x.args.id!).symbol,
      amount: x.args.amount!,
      decimals: collat(x.args.id!).decimals,
      detail: `Spoke collateral credited (${spokeByWormholeChain(collat(x.args.id!).chainId)?.label ?? `Wormhole chain ${collat(x.args.id!).chainId}`})`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of releases) {
    const c = collat(x.args.id!);
    const spoke = spokeByWormholeChain(c.chainId);
    push({
      kind: 'Release',
      asset: c.symbol,
      amount: x.args.amount!,
      decimals: c.decimals,
      detail: `RELEASE #${x.args.sequence} sent to ${spoke?.label ?? 'spoke'}`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
      message: spoke
        ? {
            direction: 'release',
            target: spoke.name,
            emitterChain: HUB.wormholeChainId,
            emitter: dep.contracts.wormholeAdapter,
            sequence: x.args.sequence!.toString(),
            label: `${fmt(units(x.args.amount!, c.decimals), 4)} ${c.symbol} back to ${spoke.label}`,
          }
        : undefined,
    });
  }
  for (const x of borrows)
    push({
      kind: 'Borrow',
      asset: market(x.args.marketId!).symbol,
      amount: x.args.amount!,
      decimals: market(x.args.marketId!).decimals,
      detail: 'Borrowed from Mezo Hub',
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of repays)
    push({
      kind: 'Repay',
      asset: market(x.args.marketId!).symbol,
      amount: x.args.amount!,
      decimals: market(x.args.marketId!).decimals,
      detail: 'Debt repaid',
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  // An unwind repays with collateral too; its Unwound row already tells that story.
  const unwindTxs = new Set(unwinds.map((x) => x.transactionHash));
  for (const x of repaidWithShares) {
    if (unwindTxs.has(x.transactionHash) || x.args.marketId === undefined || x.args.collateralId === undefined || x.args.repaid === undefined) continue;
    const m = market(x.args.marketId);
    push({
      kind: 'Repay',
      asset: m.symbol,
      amount: x.args.repaid,
      decimals: m.decimals,
      detail: `Repaid with posted ${collat(x.args.collateralId).symbol}`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  }
  for (const x of loops)
    push({
      kind: 'Loop',
      asset: 'MUSD',
      amount: x.args.principal!,
      decimals: 18,
      detail: `${Number(x.args.leverage!) / 1e18}× via flash loan · debt ${(Number(x.args.debt!) / 1e18).toFixed(2)} MUSD`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of unwinds)
    push({
      kind: 'Unwind',
      asset: 'MUSD',
      amount: x.args.out!,
      decimals: 18,
      detail: 'Loop closed, equity returned',
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of opened) {
    const principal = Number(x.args.principal!);
    push({
      kind: 'Loop',
      asset: 'BTC',
      amount: x.args.principal!,
      decimals: 18,
      detail: `${principal > 0 ? ((principal + Number(x.args.bought!)) / principal).toFixed(2) : '—'}× BTC via Tigris · debt ${(Number(x.args.debt!) / 1e18).toFixed(2)} MUSD`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  }
  for (const x of closed)
    push({
      kind: 'Unwind',
      asset: 'BTC',
      amount: x.args.collateralOut!,
      decimals: 18,
      detail: `BTC leverage closed · repaid ${(Number(x.args.repaid!) / 1e18).toFixed(2)} MUSD, sold ${(Number(x.args.sold!) / 1e18).toFixed(6)} BTC`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of liqs)
    push({
      kind: 'Liquidation',
      asset: market(x.args.marketId!).symbol,
      amount: x.args.repaid!,
      decimals: market(x.args.marketId!).decimals,
      detail: `Liquidated by ${x.args.liquidator!.slice(0, 8)}…`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });

  return withTimestamps(client, HUB.name, items);
}

async function spokeActivity(client: PublicClient, spoke: (typeof SPOKES)[number], account: Address, range: BlockRange): Promise<ActivityItem[]> {
  if (!spoke.deployment) return [];
  const gateway = spoke.deployment.contracts.spokeGateway;
  const logs = await client.getContractEvents({ address: gateway, abi: spokeGatewayAbi, eventName: 'Deposited', args: { account }, ...range });
  const items: ActivityItem[] = logs.map((x) => {
    const symbol = x.args.token!.toLowerCase() === spoke.deployment!.tokens.WETH.toLowerCase() ? 'WETH' : 'USDC';
    const decimals = symbol === 'WETH' ? 18 : 6;
    return {
      id: `${x.transactionHash}-${x.logIndex}`,
      kind: 'Cross-chain',
      network: spoke.name,
      asset: symbol,
      amount: x.args.amount!,
      decimals,
      detail: `Locked on ${spoke.label} · DEPOSIT #${x.args.sequence}`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      timestamp: null,
      message: {
        direction: 'deposit',
        target: HUB.name,
        emitterChain: spoke.wormholeChainId,
        emitter: gateway,
        sequence: x.args.sequence!.toString(),
        label: `${fmt(units(x.args.amount!, decimals), 4)} ${symbol} from ${spoke.label}`,
      },
    };
  });
  return withTimestamps(client, spoke.name, items);
}

/** Spoke history is scanned for a recent window (see spokeHistoryStart); hub history is complete. */
export type ActivityResult = { items: ActivityItem[]; spokeErrors: string[] };

export function useActivity() {
  const { address } = useAccount();
  const hub = useHubClient();
  const protocol = useProtocol();
  const spokeClients = useSpokeClients();
  return useQuery({
    queryKey: QK.activity(address),
    enabled: Boolean(address && hub && protocol.data),
    refetchInterval: 20_000,
    queryFn: async (): Promise<ActivityResult> => {
      const dep = HUB.deployment!;
      const hubLatest = await hub!.getBlockNumber();
      // Chunked, incremental and kept per browser: public RPCs cap eth_getLogs ranges (Mezo: 5,000 blocks).
      const hubItems = await scanIncremental(
        `${ENV_NAME}:hub:${dep.contracts.vaultManager}:${address}`.toLowerCase(),
        BigInt(dep.startBlock),
        hubLatest,
        (r) => hubActivity(hub!, protocol.data!, address!, r),
        HUB.maxLogRange,
        { persist: true },
      );
      const spokeErrors: string[] = [];
      const spokeItems = (
        await Promise.all(
          SPOKES.map(async (s, i) => {
            const client = spokeClients[i];
            if (!client || !s.deployment) return [];
            try {
              const latest = await client.getBlockNumber();
              const start = spokeHistoryStart(latest, BigInt(s.deployment.startBlock), s.maxLogRange);
              return await scanIncremental(
                `${ENV_NAME}:spoke:${s.deployment.contracts.spokeGateway}:${address}`.toLowerCase(),
                start,
                latest,
                (r) => spokeActivity(client, s, address!, r),
                s.maxLogRange,
                { persist: true },
              );
            } catch (err) {
              spokeErrors.push(`${s.label}: ${readError(err)}`);
              return [];
            }
          }),
        )
      ).flat();
      const items = [...hubItems, ...spokeItems].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      return { items, spokeErrors };
    },
  });
}
