import { join } from 'node:path';
import { hexToBigInt, hexToNumber, parseEventLogs, sliceHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import {
  GAS_FLOOR,
  MessageType,
  NETWORKS,
  decodePayload,
  fetchSignedVaa,
  fromBytes32,
  keeperGatewayAbi,
  parseLogMessagePublished,
  signDevVaa,
  spokeGatewayAbi,
  vaaDigest,
  wormholeAdapterAbi,
  type NetworkName,
} from '@mezodot/sdk';
import type { Context } from './context';
import { errorText, publicError } from './errors';
import { LogWindow, isRateLimited } from './scan';
import { JsonStore, appendArchive, sameAddress } from './store';
import type { TxSender } from './tx';

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
  /** Source transaction ('0x' for a message recovered from a sequence gap). */
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
  deliveredAt?: number;
  observedAt: number;
  /** Contract that executes the message on the target (hub adapter or spoke gateway); absent in older records. */
  targetContract?: Address;
  /** Signed-VAA lookups that found nothing yet. */
  vaaPolls?: number;
  /** Recovered from a sequence gap instead of a scanned log. */
  backfilled?: boolean;
  /**
   * The RELEASE was delivered but the token transfer to the recipient failed: SpokeGateway kept the amount as
   * claimable[recipient][token], and the recipient calls claim(token, to) to collect it.
   */
  deferred?: { recipient: Address; token: Address; amount: bigint };
};

/** Scan progress of one source network, tied to the contract it scans: another deployment never resumes it. */
export type Cursor = { block: bigint; contract: Address };

/** Per emitter: the lowest sequence not seen yet and the sequences seen above it (non-empty means a gap). */
export type SequenceTrack = { next: bigint; ahead: bigint[] };

type RelayState = {
  cursors: Partial<Record<NetworkName, Cursor>>;
  messages: Record<string, RelayMessage>;
  sequences: Record<string, SequenceTrack>;
};

type Source = {
  network: NetworkName;
  client: PublicClient;
  /** Emitter whose messages this source carries: the SpokeGateway (deposits) or the hub WormholeAdapter (releases). */
  contract: Address;
  startBlock: number;
  direction: Direction;
  emitterChain: number;
};

type ScannedMessage = { sequence: bigint; txHash: Hex; blockNumber: bigint; target: NetworkName | null };

/** eth_getLogs windows per source per tick, so a backlog drains without starving other sources. */
const WINDOWS_PER_TICK = 25;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** Signed-VAA lookups back off from 10 s to 1 min while guardians have not signed yet. */
const VAA_POLL_MS = 10_000;
const VAA_POLL_MAX_MS = 60_000;
/** Delivered messages kept for /messages: the newest ones, and none older than a week. */
const KEEP_DELIVERED = 500;
const KEEP_DELIVERED_MS = 7 * 24 * 3_600_000;
/** A missing sequence is looked up at most this often. */
const BACKFILL_RETRY_MS = 60_000;
/** Node answers meaning the RPC does not support the "finalized" block tag. */
const NO_FINALIZED_TAG = /finali[sz]ed|block tag|unknown block|invalid (argument|param|block)|not supported/i;
/** An RPC that refused the "finalized" tag is asked again after this long (it may have been a passing answer, or an upgrade). */
export const FINALIZED_RETRY_MS = 10 * 60_000;
/** How long a tick waits for the deliveries it started when the config sets no POLL_MS (the rest go on in the background). */
const DEFAULT_DELIVERY_WAIT_MS = 4_000;

/**
 * Whether a failed `getBlock({ blockTag: 'finalized' })` means the RPC does not know the tag. Only what the node said
 * counts: viem repeats the request body (which names "finalized") in every error message, so a timeout or a 5xx
 * would otherwise read as an unsupported tag.
 */
export const rejectsFinalizedTag = (err: unknown): boolean => !isRateLimited(err) && NO_FINALIZED_TAG.test(errorText(err));

/** Resolves true once every promise settled, or false after `ms`. */
async function settledWithin(work: Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([Promise.allSettled(work).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Exponential backoff for the n-th consecutive failure (n >= 1), capped. Messages are never abandoned. */
export const retryDelayMs = (attempts: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

/** Wait before the next signed-VAA lookup after `polls` lookups found nothing. */
export const vaaPollDelayMs = (polls: number): number => Math.min(VAA_POLL_MAX_MS, Math.round(VAA_POLL_MS * 1.5 ** Math.max(0, polls - 1)));

/** A message still pending this long after it was observed is stuck: 3× the source chain's finality. */
export const stuckAfterMs = (source: NetworkName): number => 3 * NETWORKS[source].finalitySec * 1_000;

export const messageId = (emitterChain: number, emitter: Address, sequence: bigint) => `${emitterChain}/${emitter.toLowerCase()}/${sequence}`;
const emitterKey = (emitterChain: number, emitter: Address) => `${emitterChain}/${emitter.toLowerCase()}`;

/** Wormhole digest that contracts use as the replay key (re-exported from the SDK). */
export const vaaHash = vaaDigest;

/** Emitter, sequence and payload of a signed VAA (v1 layout: header, signatures, body). */
export function parseVaa(vaa: Hex): { emitterChain: number; emitter: Address; sequence: bigint; payload: Hex } {
  const body = 6 + hexToNumber(sliceHex(vaa, 5, 6)) * 66;
  return {
    emitterChain: hexToNumber(sliceHex(vaa, body + 8, body + 10)),
    emitter: fromBytes32(sliceHex(vaa, body + 10, body + 42)),
    sequence: hexToBigInt(sliceHex(vaa, body + 42, body + 50)),
    payload: sliceHex(vaa, body + 51),
  };
}

/** The ReleaseDeferred event a SpokeGateway delivery emitted (the token transfer to the recipient failed), if any. */
export function releaseDeferred(receipt: Pick<TransactionReceipt, 'logs'>, gateway: Address | null): RelayMessage['deferred'] | null {
  const logs = parseEventLogs({ abi: spokeGatewayAbi, eventName: 'ReleaseDeferred', logs: receipt.logs ?? [] });
  const log = logs.find((l) => gateway === null || sameAddress(l.address, gateway));
  return log ? { recipient: log.args.recipient, token: log.args.token, amount: log.args.amount } : null;
}

/** Records `sequence` as seen for an emitter, advancing past every contiguous sequence. */
export function markSeen(tracks: Record<string, SequenceTrack>, key: string, sequence: bigint): void {
  const t = (tracks[key] ??= { next: 0n, ahead: [] });
  if (sequence < t.next || t.ahead.includes(sequence)) return;
  if (sequence !== t.next) {
    t.ahead.push(sequence);
    t.ahead.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return;
  }
  t.next += 1n;
  while (t.ahead.length > 0 && t.ahead[0] === t.next) {
    t.ahead.shift();
    t.next += 1n;
  }
}

export type RelayerSummary = {
  pending: number;
  waitingVaa: number;
  ready: number;
  stuck: { id: string; direction: Direction; status: MessageStatus; ageSec: number; attempts: number; lastError?: string }[];
  oldestPendingAgeSec: number | null;
  gaps: { emitter: string; missing: string[] }[];
};

/**
 * Permissionless relayer for both directions:
 *   spoke SpokeGateway.Deposited  → hub KeeperGateway.relayMessage
 *   hub WormholeAdapter.ReleaseSent → spoke SpokeGateway.receiveMessage
 * Safety does not depend on the relayer (contracts verify VAAs); it only provides liveness.
 *
 * Sources with guardian-signed VAAs are scanned up to their finalized block (guardians sign nothing earlier, so
 * this costs no latency and no reorg can move a log below the cursor). Per-emitter sequences are tracked: a
 * sequence that never showed up in the logs is fetched by number from the VAA sources.
 *
 * Deliveries run in one queue per target chain, so a congested chain (a release stuck through every fee bump on a
 * spoke) never holds up deposits to the hub or releases to the other spokes, nor the next scans.
 */
export class Relayer {
  readonly store: JsonStore<RelayState>;
  private readonly windows = new Map<NetworkName, LogWindow>();
  /** Messages being delivered right now (loop or MCP tool): never two deliveries of the same message. */
  private readonly inFlight = new Set<string>();
  /** Networks whose RPC refused the "finalized" tag, and until when they are scanned to the latest block instead. */
  private readonly noFinalizedTagUntil = new Map<NetworkName, number>();
  /** Delivery queue per target chain while it works through the messages it was given. */
  private readonly queues = new Map<NetworkName, Promise<void>>();
  private readonly backfillTried = new Map<string, number>();
  private readonly archivePath: string;
  /** Sources whose scan is failing: since when, and the latest error (logged once per change). */
  private readonly scanErrors = new Map<NetworkName, { since: number; error: string }>();

  constructor(
    private readonly ctx: Context,
    private readonly fetchImpl: typeof fetch = ctx.fetch ?? fetch,
    private readonly now: () => number = Date.now,
  ) {
    const file = join(ctx.config.stateDir, `relayer-${ctx.config.env}.json`);
    this.archivePath = join(ctx.config.stateDir, `relayer-${ctx.config.env}.archived.json`);
    this.store = new JsonStore<RelayState>(file, { cursors: {}, messages: {}, sequences: {} }, { readOnly: ctx.config.stateReadOnly });
    this.reconcileDeployment();
  }

  messages(): RelayMessage[] {
    return Object.values(this.store.get().messages).sort((a, b) => b.observedAt - a.observedAt);
  }

  pending(): RelayMessage[] {
    return this.messages().filter((m) => m.status !== 'delivered');
  }

  isStuck(m: RelayMessage, now = this.now()): boolean {
    return m.status !== 'delivered' && now - m.observedAt > stuckAfterMs(m.source);
  }

  /** Sequences missing below the highest one seen, per emitter (first 20 of each). */
  gaps(): { emitter: string; missing: bigint[] }[] {
    const out: { emitter: string; missing: bigint[] }[] = [];
    for (const [emitter, t] of Object.entries(this.store.get().sequences)) {
      if (t.ahead.length === 0) continue;
      const missing: bigint[] = [];
      const seen = new Set(t.ahead);
      for (let s = t.next; s < t.ahead[t.ahead.length - 1] && missing.length < 20; s++) if (!seen.has(s)) missing.push(s);
      out.push({ emitter, missing });
    }
    return out;
  }

  summary(now = this.now()): RelayerSummary {
    const pending = this.pending();
    const oldest = pending.reduce<number | null>((min, m) => (min === null || m.observedAt < min ? m.observedAt : min), null);
    return {
      pending: pending.length,
      waitingVaa: pending.filter((m) => !m.vaa).length,
      ready: pending.filter((m) => m.vaa).length,
      stuck: pending
        .filter((m) => this.isStuck(m, now))
        .map((m) => ({
          id: m.id,
          direction: m.direction,
          status: m.status,
          ageSec: Math.round((now - m.observedAt) / 1000),
          attempts: m.attempts,
          lastError: m.lastError,
        })),
      oldestPendingAgeSec: oldest === null ? null : Math.round((now - oldest) / 1000),
      gaps: this.gaps().map((g) => ({ emitter: g.emitter, missing: g.missing.map(String) })),
    };
  }

  /** Sources whose log scan keeps failing (their new messages go unseen), oldest failure first. */
  failingScans(): { network: NetworkName; since: number; error: string }[] {
    return [...this.scanErrors].map(([network, e]) => ({ network, ...e })).sort((a, b) => a.since - b.since);
  }

  /** Whether this agent can deliver to `target` (it has a keeper wallet there). */
  canDeliver(target: NetworkName): boolean {
    return this.senderFor(target) !== null;
  }

  async tick(): Promise<void> {
    // Each source is scanned independently: one unreachable RPC must not stall the others.
    for (const src of this.sources()) {
      await this.scanSource(src).then(
        () => this.scanRecovered(src.network),
        (err: unknown) => this.scanFailed(src.network, err),
      );
    }
    await this.backfill().catch((err: unknown) => this.ctx.log('relayer', 'sequence backfill failed', { error: publicError(err) }));
    // Usually done in seconds; a chain whose deliveries take longer keeps its queue running past this tick.
    await settledWithin(this.dispatch(), this.ctx.config.pollMs ?? DEFAULT_DELIVERY_WAIT_MS);
    this.prune();
  }

  /** Resolves true once no delivery is in progress, or false after `timeoutMs` (graceful shutdown). */
  idle(timeoutMs: number): Promise<boolean> {
    return settledWithin([...this.queues.values()], timeoutMs);
  }

  /**
   * Starts a delivery queue for every target chain with messages due and no queue running yet: each delivers its
   * messages in turn (their sender serializes them anyway), independently of the other chains.
   */
  private dispatch(): Promise<void>[] {
    const now = this.now();
    const due = this.pending().filter((m) => (m.nextAttemptAt ?? 0) <= now && !this.inFlight.has(m.id));
    for (const target of new Set(due.map((m) => m.target))) {
      if (this.queues.has(target)) continue; // still busy with an earlier batch
      const batch = due.filter((m) => m.target === target);
      const queue = (async () => {
        for (const m of batch) await this.advance(m).catch((err: unknown) => this.fail(m, err));
      })().finally(() => this.queues.delete(target));
      this.queues.set(target, queue);
    }
    return [...this.queues.values()];
  }

  /** Manually relay one message (MCP tool). A failure is recorded on the message like a loop attempt. */
  /** Relays one message now; null when delivery found it addressed elsewhere and archived it as undeliverable. */
  async relay(id: string): Promise<RelayMessage | null> {
    const m = this.store.get().messages[id];
    if (!m) throw new Error(`Unknown message ${id}`);
    if (this.inFlight.has(id)) throw new Error(`Message ${id} is already being relayed`);
    try {
      await this.advance(m, true);
    } catch (err) {
      this.fail(m, err);
      throw err;
    }
    return this.store.get().messages[id] ?? null;
  }

  // --- deployment identity ---------------------------------------------------------

  private sources(): Source[] {
    const { hub } = this.ctx;
    return [
      ...this.ctx.spokes.map((sp): Source => ({
        network: sp.network,
        client: sp.client,
        contract: sp.deployment.contracts.spokeGateway,
        startBlock: sp.deployment.startBlock,
        direction: 'deposit',
        emitterChain: sp.deployment.wormholeChainId,
      })),
      {
        network: hub.network,
        client: hub.client,
        contract: hub.deployment.contracts.wormholeAdapter,
        startBlock: hub.deployment.startBlock,
        direction: 'release',
        emitterChain: hub.deployment.wormholeChainId,
      },
    ];
  }

  /** Contract that executes a message on `target`: the hub adapter (through KeeperGateway) or the spoke gateway. */
  private targetContract(target: NetworkName): Address | null {
    if (target === this.ctx.hub.network) return this.ctx.hub.deployment.contracts.wormholeAdapter ?? null;
    return this.ctx.spokes.find((s) => s.network === target)?.deployment.contracts.spokeGateway ?? null;
  }

  /** Wormhole chain id of `target`. */
  private targetChainId(target: NetworkName): number | null {
    if (target === this.ctx.hub.network) return this.ctx.hub.deployment.wormholeChainId;
    return this.ctx.spokes.find((s) => s.network === target)?.deployment.wormholeChainId ?? null;
  }

  /**
   * State written for other contracts (a redeploy, or a state file older than deployment identities) is not
   * resumed: those cursors restart at the current deployment's start block, and undelivered messages of the old
   * contracts move to the archive file instead of being retried forever against contracts that reject them.
   */
  private reconcileDeployment(): void {
    const sources = this.sources();
    const reset: NetworkName[] = [];
    const archived: RelayMessage[] = [];
    this.store.update((s) => {
      s.sequences ??= {};
      for (const src of sources) {
        const c: unknown = s.cursors[src.network];
        if (c === undefined) continue;
        if (typeof c === 'object' && c !== null && sameAddress((c as Cursor).contract, src.contract)) continue;
        delete s.cursors[src.network];
        reset.push(src.network);
      }
      for (const [id, m] of Object.entries(s.messages)) {
        const src = sources.find((x) => x.network === m.source);
        const target = this.targetContract(m.target);
        const current =
          src !== undefined && sameAddress(src.contract, m.emitter) && target !== null && (!m.targetContract || sameAddress(m.targetContract, target));
        if (current) {
          m.targetContract ??= target;
          if (m.status === 'delivered') delete m.vaa;
          continue;
        }
        delete s.messages[id];
        if (m.status !== 'delivered') archived.push(m);
      }
      const emitters = new Set(sources.map((x) => emitterKey(x.emitterChain, x.contract)));
      for (const key of Object.keys(s.sequences)) if (!emitters.has(key)) delete s.sequences[key];
    });
    if (reset.length > 0) this.ctx.log('relayer', 'cursor belongs to another deployment: rescanning from the start block', { networks: reset });
    if (archived.length > 0 && !this.store.readOnly) {
      appendArchive(this.archivePath, { archivedAt: new Date(this.now()).toISOString(), reason: 'deployment replaced', messages: archived });
      this.ctx.log('relayer', 'undelivered messages of a replaced deployment archived; relay them by hand', {
        count: archived.length,
        ids: archived.map((m) => m.id),
        file: this.archivePath,
      });
    }
  }

  // --- discovery -------------------------------------------------------------

  private usesGuardians(network: NetworkName): boolean {
    return (this.ctx.config.vaaApis?.[network]?.length ?? 0) > 0;
  }

  private windowFor(network: NetworkName): LogWindow {
    let w = this.windows.get(network);
    if (!w) this.windows.set(network, (w = new LogWindow(NETWORKS[network].maxLogRange)));
    return w;
  }

  /** Whether `network` is scanned to its latest block for now (its RPC refused the "finalized" tag recently). */
  private scansToLatest(network: NetworkName): boolean {
    const until = this.noFinalizedTagUntil.get(network);
    return until !== undefined && this.now() < until;
  }

  /**
   * Last block worth scanning: the finalized one where guardians sign, else the latest. Only an RPC that answers
   * that it does not know the tag is scanned to the latest block, and only until FINALIZED_RETRY_MS later: a timeout,
   * a 5xx or a rate limit fails this scan instead (the next tick tries again).
   */
  private async head(src: Source): Promise<bigint> {
    if (!this.usesGuardians(src.network) || this.scansToLatest(src.network)) return src.client.getBlockNumber();
    const refusedBefore = this.noFinalizedTagUntil.has(src.network);
    try {
      const block = await src.client.getBlock({ blockTag: 'finalized' });
      if (block.number !== null) {
        if (refusedBefore) {
          this.noFinalizedTagUntil.delete(src.network);
          this.ctx.log('relayer', 'RPC serves the finalized block tag again; scanning to the finalized block', { network: src.network });
        }
        return block.number;
      }
    } catch (err) {
      if (!rejectsFinalizedTag(err)) throw err;
    }
    this.noFinalizedTagUntil.set(src.network, this.now() + FINALIZED_RETRY_MS);
    if (!refusedBefore) this.ctx.log('relayer', 'RPC has no finalized block tag; scanning to the latest block', { network: src.network });
    return src.client.getBlockNumber();
  }

  /**
   * Scans [cursor, head] of one source in windows the RPC accepts, persisting the cursor after each window.
   * The window starts at the network's known cap (Base Sepolia's public RPC allows 200 blocks), halves when an
   * RPC refuses the range and grows back later; rate limiting fails the tick without shrinking it.
   */
  private async scanSource(src: Source): Promise<void> {
    const head = await this.head(src);
    const window = this.windowFor(src.network);
    for (let i = 0; i < WINDOWS_PER_TICK; i++) {
      const cursor = this.store.get().cursors[src.network];
      const from = cursor ? cursor.block : BigInt(src.startBlock);
      if (from > head) return;
      let to = head;
      let found: ScannedMessage[];
      for (;;) {
        to = from + window.size - 1n < head ? from + window.size - 1n : head;
        try {
          found = await this.query(src, from, to);
          window.succeeded();
          break;
        } catch (err) {
          if (!window.shrink(err)) throw err;
          this.ctx.log('relayer', 'log range refused, shrinking window', { network: src.network, window: String(window.size) });
        }
      }
      this.store.update((s) => {
        for (const f of found) {
          markSeen(s.sequences, emitterKey(src.emitterChain, src.contract), f.sequence);
          if (f.target) this.observe(s, src, f.target, { sequence: f.sequence, txHash: f.txHash, blockNumber: f.blockNumber });
        }
        s.cursors[src.network] = { block: to + 1n, contract: src.contract };
      });
    }
  }

  private async query(src: Source, fromBlock: bigint, toBlock: bigint): Promise<ScannedMessage[]> {
    if (src.direction === 'deposit') {
      const logs = await src.client.getContractEvents({ address: src.contract, abi: spokeGatewayAbi, eventName: 'Deposited', fromBlock, toBlock });
      return logs.map((log) => ({ sequence: log.args.sequence!, txHash: log.transactionHash, blockNumber: log.blockNumber, target: this.ctx.hub.network }));
    }
    const logs = await src.client.getContractEvents({ address: src.contract, abi: wormholeAdapterAbi, eventName: 'ReleaseSent', fromBlock, toBlock });
    return logs.map((log) => ({
      sequence: log.args.sequence!,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      // A release to a spoke this agent does not serve still counts as seen for the sequence check.
      target: this.ctx.spokes.find((sp) => sp.deployment.wormholeChainId === Number(log.args.chainId))?.network ?? null,
    }));
  }

  private observe(
    s: RelayState,
    src: Source,
    target: NetworkName,
    m: { sequence: bigint; txHash: Hex; blockNumber: bigint; vaa?: Hex; backfilled?: boolean },
  ): void {
    const id = messageId(src.emitterChain, src.contract, m.sequence);
    if (s.messages[id]) return;
    // Scanned to the latest block (the RPC has no "finalized" tag): guardians sign once the block is final, so the
    // first signed-VAA lookup waits for that instead of polling Wormholescan for the whole finality window.
    const awaitFinality = !m.vaa && this.usesGuardians(src.network) && this.scansToLatest(src.network);
    const now = this.now();
    s.messages[id] = {
      id,
      direction: src.direction,
      source: src.network,
      target,
      emitterChain: src.emitterChain,
      emitter: src.contract,
      sequence: m.sequence,
      txHash: m.txHash,
      blockNumber: m.blockNumber,
      status: m.vaa ? 'ready' : 'waiting_vaa',
      attempts: 0,
      observedAt: now,
      targetContract: this.targetContract(target) ?? undefined,
      ...(m.vaa ? { vaa: m.vaa } : {}),
      ...(m.backfilled ? { backfilled: true } : {}),
      ...(awaitFinality ? { nextAttemptAt: now + NETWORKS[src.network].finalitySec * 1_000 } : {}),
    };
    this.ctx.log('relayer', 'observed', { id, direction: src.direction, ...(m.backfilled ? { backfilled: true } : {}) });
  }

  /** Looks up the lowest missing sequence of each emitter with a gap; found VAAs become ready messages. */
  private async backfill(): Promise<void> {
    const now = this.now();
    for (const src of this.sources()) {
      if (!this.usesGuardians(src.network)) continue;
      const key = emitterKey(src.emitterChain, src.contract);
      const t = this.store.get().sequences[key];
      if (!t || t.ahead.length === 0) continue;
      const sequence = t.next;
      const tryKey = `${key}/${sequence}`;
      const last = this.backfillTried.get(tryKey);
      if (last !== undefined && now - last < BACKFILL_RETRY_MS) continue;
      if (last === undefined)
        this.ctx.log('relayer', 'sequence gap: a message never showed up in the logs; fetching its VAA', { emitter: key, sequence: String(sequence) });
      this.backfillTried.set(tryKey, now);
      const vaa = await this.fetchVaa(src.network, src.emitterChain, src.contract, sequence);
      if (!vaa) continue;
      const body = parseVaa(vaa);
      if (body.sequence !== sequence || !sameAddress(body.emitter, src.contract)) throw new Error(`VAA source returned another message for ${tryKey}`);
      const payload = decodePayload(body.payload);
      const target =
        payload.msgType === MessageType.DEPOSIT
          ? this.ctx.hub.network
          : (this.ctx.spokes.find((sp) => sp.deployment.wormholeChainId === payload.targetChain)?.network ?? null);
      this.store.update((s) => {
        markSeen(s.sequences, key, sequence);
        if (target) this.observe(s, src, target, { sequence, txHash: '0x', blockNumber: 0n, vaa, backfilled: true });
      });
      this.backfillTried.delete(tryKey);
    }
  }

  // --- delivery -----------------------------------------------------------------

  private async advance(m: RelayMessage, manual = false): Promise<void> {
    if (this.inFlight.has(m.id)) {
      if (manual) throw new Error(`Message ${m.id} is already being relayed`);
      return;
    }
    this.inFlight.add(m.id);
    try {
      await this.deliver(this.store.get().messages[m.id] ?? m);
    } finally {
      this.inFlight.delete(m.id);
    }
  }

  private async deliver(m: RelayMessage): Promise<void> {
    if (m.status === 'delivered') return;
    const vaa = m.vaa ?? (await this.obtainVaa(m));
    if (!vaa) {
      // Guardians have not signed yet: poll again later (backing off) without counting a failure.
      const polls = (m.vaaPolls ?? 0) + 1;
      this.patch(m.id, { vaaPolls: polls, nextAttemptAt: this.now() + vaaPollDelayMs(polls) });
      return;
    }
    // The payload names the only contract allowed to execute the message. One addressed elsewhere (a deposit made
    // under a replaced hub, seen again by a rescan of a reused spoke) reverts WrongTarget forever: archive it.
    const elsewhere = this.addressedElsewhere(m, vaa);
    if (elsewhere) {
      this.archiveMisaddressed(m, vaa, elsewhere);
      return;
    }
    if (!m.vaa) this.patch(m.id, { vaa, status: 'ready' });

    if (await this.isConsumed(m, vaaHash(vaa))) {
      this.delivered(m.id);
      this.ctx.log('relayer', 'already delivered', { id: m.id });
      return;
    }
    const sender = this.senderFor(m.target);
    if (!sender) return; // read-only agent: report as pending
    const { hash, receipt } = await sender.send(this.deliveryRequest(m, vaa), { kind: `relay-${m.direction}`, floor: GAS_FLOOR.vaaRelay });
    // A reverted delivery (e.g. raced by another relayer) is retried; the next attempt's isConsumed check marks it
    // delivered if someone else got there first.
    if (receipt.status !== 'success') throw new Error(`delivery transaction ${hash} reverted`);
    this.delivered(m.id, hash);
    const deferred = m.direction === 'release' ? releaseDeferred(receipt, this.targetContract(m.target)) : null;
    if (deferred) {
      this.patch(m.id, { deferred });
      this.ctx.log('relayer', 'release delivered but deferred: the recipient must call SpokeGateway.claim(token, to)', {
        id: m.id,
        txHash: hash,
        network: m.target,
        recipient: deferred.recipient,
        token: deferred.token,
        amount: String(deferred.amount),
      });
      return;
    }
    this.ctx.log('relayer', 'delivered', { id: m.id, txHash: hash });
  }

  /**
   * Why `vaa` can never be executed on the message's target: its payload is addressed to another chain or contract
   * (null when it is addressed here, or cannot be decoded: then the target contract decides).
   */
  private addressedElsewhere(m: RelayMessage, vaa: Hex): string | null {
    let payload: ReturnType<typeof decodePayload>;
    try {
      payload = decodePayload(parseVaa(vaa).payload);
    } catch {
      return null;
    }
    const expectedType = m.direction === 'deposit' ? MessageType.DEPOSIT : MessageType.RELEASE;
    if (payload.msgType !== expectedType) return `it carries message type ${payload.msgType}, not ${expectedType}`;
    const chain = this.targetChainId(m.target);
    const contract = this.targetContract(m.target);
    if (chain === null || contract === null) return null;
    const addressed = fromBytes32(payload.target);
    if (payload.targetChain === chain && sameAddress(addressed, contract)) return null;
    return `its payload is addressed to ${addressed} on wormhole chain ${payload.targetChain}, not to ${contract} on ${chain} (a replaced deployment)`;
  }

  private archiveMisaddressed(m: RelayMessage, vaa: Hex, reason: string): void {
    this.store.update((s) => void delete s.messages[m.id]);
    if (this.store.readOnly) return;
    appendArchive(this.archivePath, { archivedAt: new Date(this.now()).toISOString(), reason: `undeliverable: ${reason}`, messages: [{ ...m, vaa }] });
    this.ctx.log('relayer', 'message addressed to another contract: archived, not retried', { id: m.id, reason, file: this.archivePath });
  }

  private delivered(id: string, deliveredTx?: Hex): void {
    this.patch(id, {
      status: 'delivered',
      ...(deliveredTx ? { deliveredTx } : {}),
      deliveredAt: this.now(),
      attempts: 0,
      lastError: undefined,
      nextAttemptAt: undefined,
      vaa: undefined, // the target's replay guard is the record now
    });
  }

  private async obtainVaa(m: RelayMessage): Promise<Hex | null> {
    if (this.usesGuardians(m.source)) return this.fetchVaa(m.source, m.emitterChain, m.emitter, m.sequence);
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

  /** Signed VAA from the first source that has it; null while none has (not signed yet). */
  private async fetchVaa(source: NetworkName, emitterChain: number, emitter: Address, sequence: bigint): Promise<Hex | null> {
    let firstError: unknown = null;
    let answered = false;
    for (const api of this.ctx.config.vaaApis?.[source] ?? []) {
      try {
        const vaa = await fetchSignedVaa(api, emitterChain, emitter, sequence, this.fetchImpl);
        if (vaa) return vaa;
        answered = true;
      } catch (err) {
        firstError ??= err;
      }
    }
    if (!answered && firstError) throw firstError;
    return null;
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

  private deliveryRequest(m: RelayMessage, vaa: Hex): object {
    if (m.direction === 'deposit') {
      return { address: this.ctx.hub.deployment.contracts.keeperGateway, abi: keeperGatewayAbi, functionName: 'relayMessage', args: [vaa] };
    }
    return { address: this.spoke(m.target).deployment.contracts.spokeGateway, abi: spokeGatewayAbi, functionName: 'receiveMessage', args: [vaa] };
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

  private senderFor(network: NetworkName): TxSender | null {
    if (network === this.ctx.hub.network) return this.ctx.hub.sender ?? null;
    return this.ctx.spokes.find((sp) => sp.network === network)?.sender ?? null;
  }

  private patch(id: string, patch: Partial<RelayMessage>): void {
    this.store.update((s) => {
      if (s.messages[id]) s.messages[id] = { ...s.messages[id], ...patch };
    });
  }

  private fail(m: RelayMessage, err: unknown): void {
    // Re-read the record: the attempt may have stored the VAA before failing, and `m` predates that.
    const current = this.store.get().messages[m.id];
    if (!current || current.status === 'delivered') return;
    const attempts = current.attempts + 1;
    const message = publicError(err);
    const delay = retryDelayMs(attempts);
    this.patch(m.id, { attempts, lastError: message, status: current.vaa ? 'ready' : 'waiting_vaa', nextAttemptAt: this.now() + delay });
    this.ctx.log('relayer', 'attempt failed', { id: m.id, attempts, retryInMs: delay, error: message });
  }

  /** Drops delivered messages beyond the newest KEEP_DELIVERED and older than a week. */
  private prune(): void {
    const now = this.now();
    const delivered = Object.values(this.store.get().messages)
      .filter((m) => m.status === 'delivered')
      .sort((a, b) => (b.deliveredAt ?? b.observedAt) - (a.deliveredAt ?? a.observedAt));
    const drop = delivered.filter((m, i) => i >= KEEP_DELIVERED || now - (m.deliveredAt ?? m.observedAt) > KEEP_DELIVERED_MS);
    if (drop.length === 0) return;
    this.store.update((s) => {
      for (const m of drop) delete s.messages[m.id];
    });
  }

  private scanFailed(network: NetworkName, err: unknown): void {
    const error = publicError(err);
    const before = this.scanErrors.get(network);
    this.scanErrors.set(network, { since: before?.since ?? this.now(), error });
    if (before?.error !== error) this.ctx.log('relayer', 'scan failed', { network, error });
  }

  private scanRecovered(network: NetworkName): void {
    const before = this.scanErrors.get(network);
    if (!before) return;
    this.scanErrors.delete(network);
    this.ctx.log('relayer', 'scan recovered', { network, failingForSec: Math.round((this.now() - before.since) / 1000) });
  }
}
