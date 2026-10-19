import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { pTokenAbi, spokeGatewayAbi, vaultManagerAbi } from '@mezodot/sdk';
import { AdminWatch } from '../src/watch';

const VAULT = '0x00000000000000000000000000000000000000a1';
const POOL = '0x00000000000000000000000000000000000000a2';
const GATEWAY = '0x00000000000000000000000000000000000000b1';
const ATTACKER = getAddress('0x000000000000000000000000000000000000bad0');
const ALICE = getAddress('0x000000000000000000000000000000000000a11c');

type Log = { address: string; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number };

const at = (blockNumber: bigint, log: Omit<Log, 'blockNumber' | 'transactionHash' | 'logIndex'>): Log => ({
  ...log,
  blockNumber,
  transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
  logIndex: 0,
});

const treasurySet = (treasury: Hex) => ({
  address: VAULT,
  topics: encodeEventTopics({ abi: vaultManagerAbi, eventName: 'TreasurySet' }) as Hex[],
  data: encodeAbiParameters([{ type: 'address' }], [treasury]),
});

/** A chain whose logs are `logs` (filtered by block range and address) with its head at `head()`. */
const chain = (logs: Log[], head: () => bigint, fail?: () => boolean) => ({
  getBlockNumber: async () => head(),
  getLogs: async ({ address, fromBlock, toBlock }: { address: string[]; fromBlock: bigint; toBlock: bigint }) => {
    if (fail?.()) throw new Error('HTTP request failed.\nURL: https://rpc.example/v2/SECRET');
    return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && address.some((a) => a.toLowerCase() === l.address.toLowerCase()));
  },
});

function watchCtx(hubClient: unknown, spokeClient: unknown, dir = mkdtempSync(join(tmpdir(), 'mezodot-watch-')), vaultManager = VAULT) {
  const logs: string[] = [];
  const ctx = {
    config: { env: 'testnet', stateDir: dir },
    hub: { network: 'mezo-testnet', client: hubClient, deployment: { startBlock: 10, contracts: { vaultManager, pMUSD: POOL } } },
    spokes: [{ network: 'base-sepolia', client: spokeClient, deployment: { startBlock: 5, contracts: { spokeGateway: GATEWAY } } }],
    log: (_s: string, m: string) => logs.push(m),
  };
  return { ctx, logs, dir };
}

describe('owner and risk-parameter events (health-monitoring-gaps)', () => {
  it("records the deployment's own setup without alerting, then queues every new event once", async () => {
    const hubLogs: Log[] = [at(11n, treasurySet('0x000000000000000000000000000000000000c0de'))];
    let head = 20n;
    const { ctx, logs } = watchCtx(
      chain(hubLogs, () => head),
      chain([], () => 100n),
    );
    const watch = new AdminWatch(ctx as never, () => 1_000);
    await watch.tick();
    expect(watch.recent().map((e) => e.event)).toEqual(['TreasurySet']); // baseline: on file, not alerted
    expect(watch.drain()).toEqual([]);

    // Later: the owner key starts an ownership transfer and points the treasury elsewhere.
    hubLogs.push(
      at(25n, {
        address: VAULT,
        topics: encodeEventTopics({ abi: vaultManagerAbi, eventName: 'OwnershipTransferStarted', args: { previousOwner: ALICE, newOwner: ATTACKER } }) as Hex[],
        data: '0x',
      }),
      at(26n, treasurySet(ATTACKER)),
    );
    head = 30n;
    await watch.tick();
    const queued = watch.drain();
    expect(queued.map((e) => [e.kind, e.label, e.event])).toEqual([
      ['control', 'VaultManager', 'OwnershipTransferStarted'],
      ['control', 'VaultManager', 'TreasurySet'],
    ]);
    expect(queued[0].args).toEqual({ previousOwner: ALICE, newOwner: ATTACKER });
    expect(queued[1].args).toEqual({ treasury: ATTACKER });
    expect(watch.counts).toEqual({ 'VaultManager.OwnershipTransferStarted': 1, 'VaultManager.TreasurySet': 1 });
    expect(logs).toContain('control event: VaultManager.TreasurySet');
    expect(watch.drain()).toEqual([]); // each event is handed out once
    await watch.tick();
    expect(watch.drain()).toEqual([]); // and never found twice
  });

  it('decodes each log with its own contract ABI: the pools and VaultManager share a BadDebtWrittenOff selector', async () => {
    const hubLogs: Log[] = [];
    let head = 10n;
    const { ctx } = watchCtx(
      chain(hubLogs, () => head),
      chain([], () => 5n),
    );
    const watch = new AdminWatch(ctx as never);
    await watch.tick();
    hubLogs.push(
      at(12n, {
        address: VAULT,
        topics: encodeEventTopics({ abi: vaultManagerAbi, eventName: 'BadDebtWrittenOff', args: { account: ALICE, marketId: 0n } }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint256' }], [7n]),
      }),
      at(12n, {
        address: POOL,
        topics: encodeEventTopics({ abi: pTokenAbi, eventName: 'BadDebtWrittenOff', args: { account: ALICE } }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 3n]),
      }),
    );
    head = 12n;
    await watch.tick();
    expect(watch.drain().map((e) => [e.label, e.kind, e.args])).toEqual([
      ['VaultManager', 'risk', { account: ALICE, marketId: '0', amount: '7' }],
      ['pMUSD', 'risk', { account: ALICE, amount: '7', fromReserves: '3' }],
    ]);
  });

  it('watches every spoke gateway, and one failing RPC does not hide the others', async () => {
    let spokeDown = false;
    const spokeLogs: Log[] = [];
    let spokeHead = 50n;
    const { ctx } = watchCtx(
      chain([], () => 20n),
      chain(
        spokeLogs,
        () => spokeHead,
        () => spokeDown,
      ),
    );
    const watch = new AdminWatch(ctx as never);
    await watch.tick();
    spokeLogs.push(
      at(60n, {
        address: GATEWAY,
        topics: encodeEventTopics({ abi: spokeGatewayAbi, eventName: 'Paused' }) as Hex[],
        data: encodeAbiParameters([{ type: 'address' }], [ALICE]),
      }),
    );
    spokeHead = 70n;
    await watch.tick();
    expect(watch.drain().map((e) => `${e.network} ${e.label}.${e.event}`)).toEqual(['base-sepolia SpokeGateway(base-sepolia).Paused']);
    spokeDown = true;
    spokeHead = 80n;
    await expect(watch.tick()).rejects.toThrow(/admin event scan failed on base-sepolia: HTTP request failed\.$/);
    expect(watch.lastError).not.toMatch(/SECRET/);
  });

  it('starts over when the contracts change (a redeploy)', async () => {
    const { ctx, dir } = watchCtx(
      chain([at(11n, treasurySet(ALICE))], () => 20n),
      chain([], () => 5n),
    );
    const first = new AdminWatch(ctx as never);
    await first.tick();
    expect(first.store.get().cursors).toEqual({ 'mezo-testnet': 21n, 'base-sepolia': 6n });
    const again = new AdminWatch(
      watchCtx(
        chain([], () => 20n),
        chain([], () => 5n),
        dir,
      ).ctx as never,
    );
    expect(again.store.get().cursors).toEqual({ 'mezo-testnet': 21n, 'base-sepolia': 6n }); // same contracts: resumed
    const redeployed = new AdminWatch(
      watchCtx(
        chain([], () => 20n),
        chain([], () => 5n),
        dir,
        '0x00000000000000000000000000000000000000a9',
      ).ctx as never,
    );
    expect(redeployed.store.get()).toMatchObject({ cursors: {}, caughtUp: {}, recent: [] });
  });
});
