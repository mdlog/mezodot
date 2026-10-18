import { join } from 'node:path';
import { decodeEventLog, toEventSelector, type Abi, type AbiEvent, type Address, type Hex, type PublicClient } from 'viem';
import { NETWORKS, oracleRouterAbi, pTokenAbi, spokeGatewayAbi, vaultManagerAbi, wormholeAdapterAbi, type NetworkName } from '@mezodot/sdk';
import type { Context } from './context';
import { publicError } from './errors';
import { LogWindow } from './scan';
import { JsonStore } from './store';

/** Changes of control: who owns a contract, which contracts it trusts, where prices and fees come from. */
const CONTROL_EVENTS = new Set([
  'OwnershipTransferStarted',
  'OwnershipTransferred',
  'VaultManagerSet',
  'AdapterSet',
  'SpokeSet',
  'HubEmitterSet',
  'FeedSet',
  'SourceSet',
  'TreasurySet',
]);
/** Risk parameters and incidents. */
const RISK_EVENTS = new Set([
  'Paused',
  'Unpaused',
  'MarketAdded',
  'CollateralAdded',
  'CollateralParamsSet',
  'LiquidationFeeSet',
  'CapsSet',
  'ReserveFactorSet',
  'ReservesWithdrawn',
  'TokenSet',
  'BadDebtWrittenOff',
]);

/** eth_getLogs windows per network per tick. */
const WINDOWS_PER_TICK = 25;
/** Events kept for /events and /health. */
const KEEP_RECENT = 200;

export type AdminEvent = {
  /** 'control' (ownership, trusted contracts, oracle feeds, treasury) or 'risk' (parameters, pauses, bad debt). */
  kind: 'control' | 'risk';
  network: NetworkName;
  contract: Address;
  label: string;
  event: string;
  /** Decoded arguments; bigints as decimal strings. */
  args: Record<string, unknown>;
  blockNumber: string;
  txHash: Hex;
  logIndex: number;
  seenAt: number;
};

type Watched = { network: NetworkName; client: PublicClient; contract: Address; label: string; abi: Abi; startBlock: number };

type WatchState = {
  /** The contracts these cursors and events belong to; anything else starts over. */
  identity: string | null;
  cursors: Partial<Record<NetworkName, bigint>>;
  /**
   * Networks scanned up to the head at least once. Events found before that (the deployment's own setup calls,
   * or history after a reset) are recorded but not alerted.
   */
  caughtUp: Partial<Record<NetworkName, boolean>>;
  recent: AdminEvent[];
};

const watchedEvents = (abi: Abi): AbiEvent[] => abi.filter((x): x is AbiEvent => x.type === 'event' && (CONTROL_EVENTS.has(x.name) || RISK_EVENTS.has(x.name)));

const plain = (v: unknown): unknown =>
  typeof v === 'bigint'
    ? v.toString()
    : Array.isArray(v)
      ? v.map(plain)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
        : v;

/**
 * Watches the hub and spoke contracts for owner and risk-parameter events (ownership transfers, oracle feeds and
 * sources, trusted spokes and emitters, treasury, fees, caps, pauses, reserve withdrawals, bad debt). Each new one
 * is logged and queued for the alert webhook (see Monitor), so a compromised or mistaken owner action is noticed
 * when it lands rather than when users report it.
 */
export class AdminWatch {
  readonly store: JsonStore<WatchState>;
  /** Events found since the last drain (not persisted: they are in `recent` and the log either way). */
  private queued: AdminEvent[] = [];
  private readonly windows = new Map<NetworkName, LogWindow>();
  /** Events seen while running, per contract label and event name (for /metrics). */
  readonly counts: Record<string, number> = {};
  lastError: string | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new JsonStore<WatchState>(
      join(ctx.config.stateDir, `watch-${ctx.config.env}.json`),
      { identity: null, cursors: {}, caughtUp: {}, recent: [] },
      { readOnly: ctx.config.stateReadOnly },
    );
    const identity = this.identity();
    if (this.store.get().identity !== identity) {
      this.store.update((s) => {
        s.identity = identity;
        s.cursors = {};
        s.caughtUp = {};
        s.recent = [];
      });
    }
  }

  private watched(): Watched[] {
    const { hub, spokes } = this.ctx;
    const c = hub.deployment.contracts;
    const onHub = (contract: Address | undefined, label: string, abi: Abi): Watched[] =>
      contract ? [{ network: hub.network, client: hub.client, contract, label, abi, startBlock: hub.deployment.startBlock }] : [];
    return [
      ...onHub(c.vaultManager, 'VaultManager', vaultManagerAbi),
      ...onHub(c.oracleRouter, 'OracleRouter', oracleRouterAbi),
      ...onHub(c.wormholeAdapter, 'WormholeAdapter', wormholeAdapterAbi),
      ...onHub(c.pMUSD, 'pMUSD', pTokenAbi),
      ...onHub(c.pMEZO, 'pMEZO', pTokenAbi),
      ...spokes.map((sp): Watched => ({
        network: sp.network,
        client: sp.client,
        contract: sp.deployment.contracts.spokeGateway,
        label: `SpokeGateway(${sp.network})`,
        abi: spokeGatewayAbi,
        startBlock: sp.deployment.startBlock,
      })),
    ];
  }

  private identity(): string {
    return this.watched()
      .map((w) => `${w.network}:${w.contract.toLowerCase()}`)
      .sort()
      .join(',');
  }

  recent(): AdminEvent[] {
    return [...this.store.get().recent].reverse();
  }

  /** New events since the last call (the alert webhook takes them). */
  drain(): AdminEvent[] {
    const out = this.queued;
    this.queued = [];
    return out;
  }

  async tick(): Promise<void> {
    const byNetwork = new Map<NetworkName, Watched[]>();
    for (const w of this.watched()) byNetwork.set(w.network, [...(byNetwork.get(w.network) ?? []), w]);
    const errors: string[] = [];
    for (const [network, group] of byNetwork) {
      await this.scan(network, group).catch((err: unknown) => errors.push(`${network}: ${publicError(err)}`));
    }
    this.lastError = errors.length > 0 ? errors.join('; ') : null;
    if (errors.length > 0) throw new Error(`admin event scan failed on ${errors.join('; ')}`);
  }

  private async scan(network: NetworkName, group: Watched[]): Promise<void> {
    const client = group[0].client;
    const latest = await client.getBlockNumber();
    // One topic filter for every watched event of every contract on this network (one entry per selector).
    const events = [...new Map(group.flatMap((w) => watchedEvents(w.abi)).map((e) => [toEventSelector(e), e])).values()];
    const addresses = group.map((w) => w.contract);
    let window = this.windows.get(network);
    if (!window) this.windows.set(network, (window = new LogWindow(NETWORKS[network]?.maxLogRange ?? 5_000n)));
    for (let i = 0; i < WINDOWS_PER_TICK; i++) {
      const s = this.store.get();
      const from = s.cursors[network] ?? BigInt(Math.min(...group.map((w) => w.startBlock)));
      if (from > latest) {
        if (!s.caughtUp[network]) this.store.update((d) => void (d.caughtUp[network] = true));
        return;
      }
      let to = latest;
      let logs: Awaited<ReturnType<typeof client.getLogs>> = [];
      for (;;) {
        to = from + window.size - 1n < latest ? from + window.size - 1n : latest;
        try {
          logs = await client.getLogs({ address: addresses, events, fromBlock: from, toBlock: to });
          window.succeeded();
          break;
        } catch (err) {
          if (!window.shrink(err)) throw err;
        }
      }
      const baseline = !s.caughtUp[network];
      const found = logs.flatMap((log): AdminEvent[] => {
        const w = group.find((x) => x.contract.toLowerCase() === log.address.toLowerCase());
        if (!w) return [];
        // Decoded with the emitting contract's own ABI: VaultManager and the pools both emit a
        // BadDebtWrittenOff(address,uint256,uint256), with different indexed arguments.
        let decoded: { eventName: string; args: unknown };
        try {
          decoded = decodeEventLog({ abi: w.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }) as { eventName: string; args: unknown };
        } catch {
          return [];
        }
        if (!CONTROL_EVENTS.has(decoded.eventName) && !RISK_EVENTS.has(decoded.eventName)) return [];
        return [
          {
            kind: CONTROL_EVENTS.has(decoded.eventName) ? 'control' : 'risk',
            network,
            contract: w.contract,
            label: w.label,
            event: decoded.eventName,
            args: plain(decoded.args ?? {}) as Record<string, unknown>,
            blockNumber: String(log.blockNumber),
            txHash: log.transactionHash as Hex,
            logIndex: Number(log.logIndex),
            seenAt: this.now(),
          },
        ];
      });
      this.store.update((d) => {
        d.recent = [...d.recent, ...found].slice(-KEEP_RECENT);
        d.cursors[network] = to + 1n;
        if (to >= latest) d.caughtUp[network] = true;
      });
      if (baseline) continue;
      for (const e of found) {
        const key = `${e.label}.${e.event}`;
        this.counts[key] = (this.counts[key] ?? 0) + 1;
        this.queued.push(e);
        this.ctx.log('watch', `${e.kind} event: ${key}`, { network, contract: e.contract, args: e.args, txHash: e.txHash });
      }
    }
  }
}
