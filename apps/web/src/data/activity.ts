import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { Address, Hex, PublicClient } from 'viem';
import { leverageManagerAbi, pTokenAbi, spokeGatewayAbi, vaultManagerAbi, type NetworkName, type ProtocolState } from '@mezodot/sdk';
import { HUB, SPOKES } from '../chain/env';
import { QK, useHubClient, useProtocol, useSpokeClients } from './hooks';

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

async function hubActivity(client: PublicClient, protocol: ProtocolState, account: Address): Promise<ActivityItem[]> {
  const dep = HUB.deployment!;
  const fromBlock = BigInt(dep.startBlock);
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
          .getContractEvents({ address: m.pool, abi: pTokenAbi, eventName: 'Deposit', args: { owner: account }, fromBlock })
          .then((l) => l.map((x) => ({ x, m }))),
      ),
    ),
    Promise.all(
      protocol.markets.map((m) =>
        client
          .getContractEvents({ address: m.pool, abi: pTokenAbi, eventName: 'Withdraw', args: { owner: account }, fromBlock })
          .then((l) => l.map((x) => ({ x, m }))),
      ),
    ),
    client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'CollateralDeposited', args: { account }, fromBlock }),
    client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'CollateralWithdrawn', args: { account }, fromBlock }),
    client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'RemoteCredited', args: { account }, fromBlock }),
    client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'RemoteWithdrawRequested', args: { account }, fromBlock }),
    client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'Borrowed', args: { account }, fromBlock }),
    client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'Repaid', args: { account }, fromBlock }),
    client.getContractEvents({ address: dep.contracts.leverageManager, abi: leverageManagerAbi, eventName: 'Looped', args: { account }, fromBlock }),
    client.getContractEvents({ address: dep.contracts.leverageManager, abi: leverageManagerAbi, eventName: 'Unwound', args: { account }, fromBlock }),
    client.getContractEvents({ address: vm, abi: vaultManagerAbi, eventName: 'Liquidated', args: { account }, fromBlock }),
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

  await withTimestamps(client, HUB.name, items);
  return items;
}

async function spokeActivity(client: PublicClient, spoke: (typeof SPOKES)[number], account: Address): Promise<ActivityItem[]> {
  if (!spoke.deployment) return [];
  const logs = await client.getContractEvents({
    address: spoke.deployment.contracts.spokeGateway,
    abi: spokeGatewayAbi,
    eventName: 'Deposited',
    args: { account },
    fromBlock: BigInt(spoke.deployment.startBlock),
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
  await withTimestamps(client, spoke.name, items);
  return items;
}

export function useActivity() {
  const { address } = useAccount();
  const hub = useHubClient();
  const protocol = useProtocol();
  const spokeClients = useSpokeClients();
  return useQuery({
    queryKey: QK.activity(address),
    enabled: Boolean(address && hub && protocol.data),
    refetchInterval: 20_000,
    queryFn: async () => {
      const all = await Promise.all([
        hubActivity(hub!, protocol.data!, address!),
        ...SPOKES.map((s, i) => (spokeClients[i] ? spokeActivity(spokeClients[i]!, s, address!).catch(() => []) : Promise.resolve([]))),
      ]);
      return all.flat().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    },
  });
}
