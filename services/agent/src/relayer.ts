import { join } from 'node:path';
import { type Address, type Hex, type PublicClient } from 'viem';
import {
  NETWORKS,
  fetchSignedVaa,
  keeperGatewayAbi,
  parseLogMessagePublished,
  signDevVaa,
  vaaDigest,
  spokeGatewayAbi,
  wormholeAdapterAbi,
  type NetworkName,
} from '@mezodot/sdk';
import type { Context, Wallet } from './context';
import { JsonStore } from './store';

export type Direction = 'deposit' | 'release';
/** 'failed' only appears in state files written by older versions; such messages are retried. */
export type MessageStatus = 'waiting_vaa' | 'ready' | 'delivered' | 'failed';

export type RelayMessage = {
  id: string;
  direction: Direction;
  source: NetworkName;
  target: NetworkName;
  emitterChain: number;
  emitter: Address;
  sequence: bigint;
  txHash: Hex;
  blockNumber: bigint;
  status: MessageStatus;
  /** Consecutive failed delivery attempts (drives the backoff). */
  attempts: number;
  lastError?: string;
  /** Epoch ms before which the message is not retried. */
  nextAttemptAt?: number;
  vaa?: Hex;
  deliveredTx?: Hex;
  observedAt: number;
};

type RelayState = { cursors: Partial<Record<NetworkName, bigint>>; messages: Record<string, RelayMessage> };

/** eth_getLogs windows per source per tick, so a backlog drains without starving other sources. */
const WINDOWS_PER_TICK = 25;
/** Smallest window the scanner shrinks to when an RPC refuses a range. */
const MIN_LOG_WINDOW = 16n;
/** Errors that mean "range too large" (wording varies by RPC provider). */
const RANGE_ERROR = /range|limit|exceed|too (many|large|big)|blocks distance|block span|response size/i;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** Pause between Wormholescan polls for a VAA that guardians have not signed yet. */
const VAA_POLL_MS = 10_000;

/** Exponential backoff for the n-th consecutive failure (n >= 1), capped. Messages are never abandoned. */
export const retryDelayMs = (attempts: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

export const messageId = (emitterChain: number, emitter: Address, sequence: bigint) => `${emitterChain}/${emitter.toLowerCase()}/${sequence}`;

/** Wormhole digest that contracts use as the replay key (re-exported from the SDK). */
export const vaaHash = vaaDigest;

/**
 * Permissionless relayer for both directions:
 *   spoke SpokeGateway.Deposited  → hub KeeperGateway.relayMessage
 *   hub WormholeAdapter.ReleaseSent → spoke SpokeGateway.receiveMessage
 * Safety does not depend on the relayer (contracts verify VAAs); it only provides liveness.
 */
export class Relayer {
  readonly store: JsonStore<RelayState>;
  /** Learned eth_getLogs window per source, starting at the network's known public-RPC cap. */
  private readonly windows = new Map<NetworkName, bigint>();

  constructor(
    private readonly ctx: Context,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new JsonStore<RelayState>(join(ctx.config.stateDir, `relayer-${ctx.config.env}.json`), { cursors: {}, messages: {} });
  }

  messages(): RelayMessage[] {
    return Object.values(this.store.get().messages).sort((a, b) => b.observedAt - a.observedAt);
  }

  pending(): RelayMessage[] {
    return this.messages().filter((m) => m.status !== 'delivered');
  }

  async tick(): Promise<void> {
    // Each source is scanned independently: one unreachable RPC must not stall the others.
    for (const spoke of this.ctx.spokes) {
      await this.scanSpoke(spoke).catch((err: unknown) => this.scanFailed(spoke.network, err));
    }
    await this.scanHub().catch((err: unknown) => this.scanFailed(this.ctx.hub.network, err));
    const now = this.now();
    for (const m of this.pending()) {
      if ((m.nextAttemptAt ?? 0) > now) continue;
      await this.advance(m).catch((err: unknown) => this.fail(m, err));
    }
  }

  // --- discovery -------------------------------------------------------------

  /**
   * Scans [cursor, latest] of one source in windows the RPC accepts, persisting the cursor after each window.
   * The window starts at the network's known cap (Base Sepolia's public RPC allows 200 blocks) and halves
   * when an RPC refuses the range, so custom RPCs with lower caps cannot stall relaying.
   */
  private async scan<T>(
    network: NetworkName,
    client: PublicClient,
    startBlock: number,
    query: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    record: (s: RelayState, logs: T[]) => void,
  ): Promise<void> {
    const latest = await client.getBlockNumber();
    for (let i = 0; i < WINDOWS_PER_TICK; i++) {
      const from = this.store.get().cursors[network] ?? BigInt(startBlock);
      if (from > latest) return;
      for (;;) {
        const window = this.windows.get(network) ?? NETWORKS[network].maxLogRange;
        const to = from + window - 1n < latest ? from + window - 1n : latest;
        try {
          const logs = await query(from, to);
          this.store.update((s) => {
            record(s, logs);
            s.cursors[network] = to + 1n;
          });
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!RANGE_ERROR.test(message) || window <= MIN_LOG_WINDOW) throw err;
          this.windows.set(network, window / 2n);
          this.ctx.log('relayer', 'log range refused, shrinking window', { network, window: String(window / 2n) });
        }
      }
    }
  }

  private async scanSpoke(spoke: Context['spokes'][number]): Promise<void> {
    await this.scan(
      spoke.network,
      spoke.client,
      spoke.deployment.startBlock,
      (fromBlock, toBlock) =>
        spoke.client.getContractEvents({ address: spoke.deployment.contracts.spokeGateway, abi: spokeGatewayAbi, eventName: 'Deposited', fromBlock, toBlock }),
      (s, logs) => {
        for (const log of logs) {
          this.observe(s, {
            direction: 'deposit',
            source: spoke.network,
            target: this.ctx.hub.network,
            emitterChain: spoke.deployment.wormholeChainId,
            emitter: spoke.deployment.contracts.spokeGateway,
            sequence: log.args.sequence!,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          });
        }
      },
    );
  }

  private async scanHub(): Promise<void> {
    const { hub } = this.ctx;
    await this.scan(
      hub.network,
      hub.client,
      hub.deployment.startBlock,
      (fromBlock, toBlock) =>
        hub.client.getContractEvents({
          address: hub.deployment.contracts.wormholeAdapter,
          abi: wormholeAdapterAbi,
          eventName: 'ReleaseSent',
          fromBlock,
          toBlock,
        }),
      (s, logs) => {
        for (const log of logs) {
          const target = this.ctx.spokes.find((sp) => sp.deployment.wormholeChainId === Number(log.args.chainId));
          if (!target) continue; // spoke not configured for this agent
          this.observe(s, {
            direction: 'release',
            source: hub.network,
            target: target.network,
            emitterChain: hub.deployment.wormholeChainId,
            emitter: hub.deployment.contracts.wormholeAdapter,
            sequence: log.args.sequence!,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          });
        }
      },
    );
  }

  private observe(s: RelayState, m: Omit<RelayMessage, 'id' | 'status' | 'attempts' | 'observedAt'>): void {
    const id = messageId(m.emitterChain, m.emitter, m.sequence);
    if (s.messages[id]) return;
    s.messages[id] = { ...m, id, status: 'waiting_vaa', attempts: 0, observedAt: this.now() };
    this.ctx.log('relayer', 'observed', { id, direction: m.direction });
  }

  // --- delivery -----------------------------------------------------------------

  private async advance(m: RelayMessage): Promise<void> {
    const vaa = m.vaa ?? (await this.obtainVaa(m));
    if (!vaa) {
      // Guardians have not signed yet: poll again later without counting a failure.
      this.patch(m.id, { nextAttemptAt: this.now() + VAA_POLL_MS });
      return;
    }
    this.patch(m.id, { vaa, status: 'ready' });

    const hash = vaaHash(vaa);
    if (await this.isConsumed(m, hash)) {
      this.patch(m.id, { status: 'delivered' });
      this.ctx.log('relayer', 'already delivered', { id: m.id });
      return;
    }
    const wallet = this.walletFor(m.target);
    if (!wallet) return; // read-only agent: report as pending
    const txHash = await this.submit(m, vaa, wallet);
    const receipt = await this.clientFor(m.target).waitForTransactionReceipt({ hash: txHash });
    // A reverted delivery (e.g. raced by another relayer, or out of gas) is retried; the next attempt's
    // isConsumed check marks it delivered if someone else got there first.
    if (receipt.status !== 'success') throw new Error(`delivery transaction ${txHash} reverted`);
    this.patch(m.id, { status: 'delivered', deliveredTx: txHash, attempts: 0, lastError: undefined, nextAttemptAt: undefined });
    this.ctx.log('relayer', 'delivered', { id: m.id, txHash });
  }

  private async obtainVaa(m: RelayMessage): Promise<Hex | null> {
    const api = NETWORKS[m.source].wormholescanApi;
    if (api) return fetchSignedVaa(api, m.emitterChain, m.emitter, m.sequence, this.fetchImpl);
    // Devnet: rebuild the message from the core log and sign with the dev guardian.
    const key = this.ctx.config.devGuardianKey;
    if (!key) throw new Error('DEVNET_GUARDIAN_KEY is required on the devnet');
    const client = this.clientFor(m.source);
    const receipt = await client.getTransactionReceipt({ hash: m.txHash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    for (const log of receipt.logs) {
      const p = parseLogMessagePublished(log);
      if (!p || p.emitter.toLowerCase() !== m.emitter.toLowerCase() || p.sequence !== m.sequence) continue;
      return signDevVaa(key, {
        timestamp: Number(block.timestamp),
        nonce: p.nonce,
        emitterChain: m.emitterChain,
        emitter: m.emitter,
        sequence: p.sequence,
        consistencyLevel: p.consistencyLevel,
        payload: p.payload,
      });
    }
    throw new Error('LogMessagePublished not found in source transaction');
  }

  private async isConsumed(m: RelayMessage, hash: Hex): Promise<boolean> {
    if (m.direction === 'deposit') {
      return this.ctx.hub.client.readContract({
        address: this.ctx.hub.deployment.contracts.wormholeAdapter,
        abi: wormholeAdapterAbi,
        functionName: 'isConsumed',
        args: [hash],
      });
    }
    const spoke = this.spoke(m.target);
    return spoke.client.readContract({ address: spoke.deployment.contracts.spokeGateway, abi: spokeGatewayAbi, functionName: 'isConsumed', args: [hash] });
  }

  private async submit(m: RelayMessage, vaa: Hex, wallet: Wallet): Promise<Hex> {
    if (m.direction === 'deposit') {
      return wallet.writeContract({
        address: this.ctx.hub.deployment.contracts.keeperGateway,
        abi: keeperGatewayAbi,
        functionName: 'relayMessage',
        args: [vaa],
      });
    }
    return wallet.writeContract({
      address: this.spoke(m.target).deployment.contracts.spokeGateway,
      abi: spokeGatewayAbi,
      functionName: 'receiveMessage',
      args: [vaa],
    });
  }

  /** Manually relay one message (MCP tool). */
  async relay(id: string): Promise<RelayMessage> {
    const m = this.store.get().messages[id];
    if (!m) throw new Error(`Unknown message ${id}`);
    await this.advance(m);
    return this.store.get().messages[id];
  }

  // --- helpers ------------------------------------------------------------------

  private spoke(network: NetworkName) {
    const s = this.ctx.spokes.find((sp) => sp.network === network);
    if (!s) throw new Error(`Spoke ${network} not configured`);
    return s;
  }

  private clientFor(network: NetworkName): PublicClient {
    return network === this.ctx.hub.network ? this.ctx.hub.client : this.spoke(network).client;
  }

  private walletFor(network: NetworkName): Wallet | null {
    return network === this.ctx.hub.network ? this.ctx.hub.wallet : this.spoke(network).wallet;
  }

  private patch(id: string, patch: Partial<RelayMessage>): void {
    this.store.update((s) => {
      s.messages[id] = { ...s.messages[id], ...patch };
    });
  }

  private fail(m: RelayMessage, err: unknown): void {
    const attempts = m.attempts + 1;
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    const status = m.status === 'failed' ? (m.vaa ? 'ready' : 'waiting_vaa') : m.status;
    const delay = retryDelayMs(attempts);
    this.patch(m.id, { attempts, lastError: message, status, nextAttemptAt: this.now() + delay });
    this.ctx.log('relayer', 'attempt failed', { id: m.id, attempts, retryInMs: delay, error: message });
  }

  private scanFailed(network: NetworkName, err: unknown): void {
    this.ctx.log('relayer', 'scan failed', { network, error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
  }
}
