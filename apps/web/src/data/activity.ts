import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { Address, Hex, PublicClient } from 'viem';
import { leverageManagerAbi, pTokenAbi, spokeGatewayAbi, vaultManagerAbi, type BlockRange, type NetworkName, type ProtocolState } from '@mezodot/sdk';
import { HUB, SPOKES } from '../chain/env';
import { QK, useHubClient, useProtocol, useSpokeClients } from './hooks';
import { scanIncremental } from './incremental';

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
};

const timestamps = new Map<string, number>();
async function withTimestamps(client: PublicClient, network: NetworkName, items: ActivityItem[]) {
  const blocks = [...new Set(items.filter((i) => i.network === network).map((i) => i.blockNumber))];
  await Promise.all(
    blocks.map(async (b) => {
      const key = `${network}:${b}`;
      if (!timestamps.has(key)) timestamps.set(key, Number((await client.getBlock({ blockNumber: b })).timestamp) * 1000);
    }),
  );
  for (const i of items) if (i.network === network) i.timestamp = timestamps.get(`${network}:${i.blockNumber}`) ?? null;
}

async function hubActivity(client: PublicClient, protocol: ProtocolState, account: Address, range: BlockRange): Promise<ActivityItem[]> {
  const dep = HUB.deployment!;
  const vm = dep.contracts.vaultManager;
  const items: ActivityItem[] = [];
  const push = (i: Omit<ActivityItem, 'id' | 'network' | 'timestamp'> & { logIndex: number }) =>
    items.push({ ...i, id: `${i.txHash}-${i.logIndex}`, network: HUB.name, timestamp: null });
  const collat = (id: bigint) => protocol.collaterals[Number(id)];
  const market = (id: bigint) => protocol.markets[Number(id)];

  const [poolDeposits, poolWithdraws, cIn, cOut, credited, releases, borrows, repays, loops, unwinds, liqs] = await Promise.all([
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
  for (const x of cIn)
    push({
      kind: 'Collateral in',
      asset: collat(x.args.id!).symbol,
      amount: x.args.amount!,
      decimals: 24,
      detail: 'Posted to VaultManager',
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of cOut)
    push({
      kind: 'Collateral out',
      asset: collat(x.args.id!).symbol,
      amount: x.args.amount!,
      decimals: 24,
      detail: 'Withdrawn from VaultManager',
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of credited)
    push({
      kind: 'Cross-chain',
      asset: collat(x.args.id!).symbol,
      amount: x.args.amount!,
      decimals: collat(x.args.id!).decimals,
      detail: `Spoke collateral credited (Wormhole chain ${collat(x.args.id!).chainId})`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
  for (const x of releases)
    push({
      kind: 'Release',
      asset: collat(x.args.id!).symbol,
      amount: x.args.amount!,
      decimals: collat(x.args.id!).decimals,
      detail: `RELEASE #${x.args.sequence} sent to spoke`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      logIndex: x.logIndex,
    });
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

  return items;
}

async function spokeActivity(client: PublicClient, spoke: (typeof SPOKES)[number], account: Address, range: BlockRange): Promise<ActivityItem[]> {
  if (!spoke.deployment) return [];
  const logs = await client.getContractEvents({
    address: spoke.deployment.contracts.spokeGateway,
    abi: spokeGatewayAbi,
    eventName: 'Deposited',
    args: { account },
    ...range,
  });
  const items: ActivityItem[] = logs.map((x) => {
    const symbol = x.args.token!.toLowerCase() === spoke.deployment!.tokens.WETH.toLowerCase() ? 'WETH' : 'USDC';
    return {
      id: `${x.transactionHash}-${x.logIndex}`,
      kind: 'Cross-chain',
      network: spoke.name,
      asset: symbol,
      amount: x.args.amount!,
      decimals: symbol === 'WETH' ? 18 : 6,
      detail: `Locked on ${spoke.label} · DEPOSIT #${x.args.sequence}`,
      txHash: x.transactionHash,
      blockNumber: x.blockNumber,
      timestamp: null,
    };
  });
  return items;
}

/** Spoke history is scanned for this many recent blocks (~2 days on Base); hub history is complete. */
export const SPOKE_HISTORY_BLOCKS = 100_000n;

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
      const hubLatest = await hub!.getBlockNumber();
      // Chunked + incremental: public RPCs cap eth_getLogs ranges (Mezo: 10,000 blocks).
      const hubItems = await scanIncremental(`hub:${address}`, BigInt(HUB.deployment!.startBlock), hubLatest, (r) =>
        hubActivity(hub!, protocol.data!, address!, r),
      );
      await withTimestamps(hub!, HUB.name, hubItems);
      const spokeErrors: string[] = [];
      const spokeItems = (
        await Promise.all(
          SPOKES.map(async (s, i) => {
            const client = spokeClients[i];
            if (!client || !s.deployment) return [];
            try {
              const latest = await client.getBlockNumber();
              const floor = latest > SPOKE_HISTORY_BLOCKS ? latest - SPOKE_HISTORY_BLOCKS : 0n;
              const start = BigInt(s.deployment.startBlock) > floor ? BigInt(s.deployment.startBlock) : floor;
              const items = await scanIncremental(`spoke:${s.name}:${address}`, start, latest, (r) => spokeActivity(client, s, address!, r));
              await withTimestamps(client, s.name, items);
              return items;
            } catch (err) {
              spokeErrors.push(`${s.label}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
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
