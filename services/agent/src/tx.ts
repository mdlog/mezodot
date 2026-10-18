import { gasWithBuffer, type NetworkName } from '@mezodot/sdk';
import {
  Eip1559FeesNotSupportedError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  concatHex,
  encodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type SerializeTransactionFn,
  type TransactionReceipt,
  type TransactionSerializable,
} from 'viem';
import type { Logger, Wallet } from './context';
import { errorText, publicError } from './errors';

/**
 * success, reverted, out_of_gas: a receipt of one of the request's own transactions. stuck: still unmined after every
 * fee bump (it may still be mined). unknown: the nonce was used, but by no transaction of the request that a receipt
 * could be found for, so another transaction almost certainly took it and the call did not happen (callers that must
 * know settle it later from chain state, TxSender.settle). failed: nothing of the request reached the chain.
 */
export type TxOutcome = 'success' | 'reverted' | 'out_of_gas' | 'stuck' | 'unknown' | 'failed';

/** Every transaction one request signed at one nonce: the first attempt and its fee bumps. */
export type BroadcastTx = { network: NetworkName; nonce: number; hashes: Hex[] };

export type SendOptions = {
  /** Call type for logs and metrics, e.g. 'pyth-push', 'relay-deposit', 'liquidation'. */
  kind: string;
  /** Minimum gas limit for this call type (GAS_FLOOR from the SDK). */
  floor?: bigint;
  /**
   * Called just before each transaction of the request is broadcast (first attempt, fee bump, out-of-gas retry) with
   * its nonce and every hash signed at that nonce so far. A caller that must not lose track of what it sent persists
   * it and settles it later with `settle` (after a restart, or when send() gave up on it). If it throws, that
   * transaction is not broadcast.
   */
  onBroadcast?: (tx: BroadcastTx) => void;
};

export type Sent = { hash: Hex; receipt: TransactionReceipt; gas: bigint; nonce: number };

/**
 * What became of a request sent earlier: mined (the receipt of one of its own transactions), dropped (another
 * transaction holds the nonce, so it never happened) or still pending (nothing holds the nonce yet).
 */
export type Settlement = { status: 'mined'; receipt: TransactionReceipt } | { status: 'dropped' } | { status: 'pending' };

/** A writeContract-style request: what every caller passes to send(). */
type WriteRequest = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint; dataSuffix?: Hex };

/** A reverted receipt that used at least this share of its gas limit (bps) ran out of gas. */
const OUT_OF_GAS_BPS = 9_800n;
/** Fee multiplier for a replacement, in bps (nodes require at least +10% on every fee field). */
const FEE_BUMP_BPS = 13_000n;
const DEFAULT_MAX_REPLACEMENTS = 2;
/** Receipt polling interval when neither the options nor the client set one, and the shortest the client's may set. */
const DEFAULT_POLL_MS = 4_000;
const MIN_POLL_MS = 1_000;
/** Outcomes remembered for the revert-rate health check. */
const RECENT_OUTCOMES = 20;
/**
 * Once the nonce has moved without a receipt of ours, receipts are polled for this long more (and at least
 * CONSUMED_RECHECKS times, never beyond the receipt timeout) before concluding that another transaction took it: the
 * receipt endpoint can lag the nonce count another replica serves.
 */
const CONSUMED_GRACE_MS = 15_000;
const CONSUMED_RECHECKS = 3;
/** Node answers meaning the nonce is already used: this sender's view of the account was behind. */
const NONCE_USED = /nonce too low|nonce has already been used|invalid nonce/i;
/**
 * Node answers that refuse a transaction outright: it is not in that node's pool. "already known" is not one (the
 * node has it), and neither is a timeout or a dropped connection (it may have arrived).
 */
const REFUSED =
  /nonce too low|nonce has already been used|invalid nonce|nonce too high|underpriced|insufficient funds|intrinsic gas|gas too low|exceeds block gas limit|fee cap|base fee|tx fee|invalid sender|invalid signature|chain ?id|execution reverted|oversized/i;

export const ranOutOfGas = (receipt: Pick<TransactionReceipt, 'status' | 'gasUsed'>, gasLimit: bigint): boolean =>
  receipt.status === 'reverted' && receipt.gasUsed * 10_000n >= gasLimit * OUT_OF_GAS_BPS;

export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };

const scale = (v: bigint) => (v * FEE_BUMP_BPS) / 10_000n + 1n;
const atLeast = (a: bigint, b: bigint) => (a > b ? a : b);
const sameHash = (a: string | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fees for a replacement: the previous ones bumped, and never below what the network asks for now. */
export function bumped(previous: Fees, current: Fees): Fees {
  if ('gasPrice' in previous) return { gasPrice: atLeast(scale(previous.gasPrice), 'gasPrice' in current ? current.gasPrice : current.maxFeePerGas) };
  const now = 'gasPrice' in current ? { maxFeePerGas: current.gasPrice, maxPriorityFeePerGas: current.gasPrice } : current;
  return {
    maxFeePerGas: atLeast(scale(previous.maxFeePerGas), now.maxFeePerGas),
    maxPriorityFeePerGas: atLeast(scale(previous.maxPriorityFeePerGas), now.maxPriorityFeePerGas),
  };
}

/**
 * The request was broadcast, but send() could not confirm that it happened. `hashes` are every transaction it signed
 * at `nonce`: whoever must know what became of it settles them later (TxSender.settle).
 */
export class SentTransactionError extends Error {
  constructor(
    readonly network: NetworkName,
    readonly nonce: number,
    readonly hashes: Hex[],
    message: string,
  ) {
    super(message);
    this.name = 'SentTransactionError';
  }
}

/** Still unmined after every replacement (or its receipts could not be read): it may still be mined. */
export class StuckTransactionError extends SentTransactionError {
  constructor(network: NetworkName, nonce: number, hashes: Hex[], reason?: string) {
    super(
      network,
      nonce,
      hashes,
      `transaction with nonce ${nonce} on ${network} is still unmined after ${hashes.length} attempts (${hashes.at(-1)})${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'StuckTransactionError';
  }
}

/**
 * Another transaction took the nonce (another request that took a stuck nonce over, a previous run, another process
 * using the key) and none of this request's own was mined: the call did not happen and must be retried.
 */
export class NonceConsumedError extends SentTransactionError {
  constructor(network: NetworkName, nonce: number, hashes: Hex[]) {
    super(
      network,
      nonce,
      hashes,
      `nonce ${nonce} on ${network} was consumed by another transaction; ${hashes.join(', ')} not mined, so the call did not happen`,
    );
    this.name = 'NonceConsumedError';
  }
}

export type TxSenderOptions = {
  /** How long one attempt may stay unmined before it is replaced with higher fees. */
  receiptTimeoutMs: number;
  log: Logger;
  maxReplacements?: number;
  /** How often receipts are polled while waiting (default: the client's polling interval). */
  pollMs?: number;
  now?: () => number;
};

/**
 * The keeper account's only way to send transactions on one chain. Sends are serialized, so the relayer, the
 * liquidator, the Pyth pusher and the agent's MCP write tools never prepare two transactions with the same nonce; each
 * one waits for its receipt (bounded) before the next is prepared. Only the agent process has senders: a process that
 * follows its state read-only (the stdio MCP server) could not persist what a transaction changes. The nonce is the
 * node's pending count, never below the one after this sender's last mined transaction (a lagging RPC replica can
 * report an older count).
 *
 * Transactions are signed locally, so every hash is known before it is broadcast: a broadcast that times out, or that
 * a fallback RPC answers with "already known", is watched like any other. Only a receipt of one of the request's own
 * transactions settles it; another transaction at the same nonce never does (NonceConsumedError), and receipt lookups
 * that fail are retried until the timeout instead of failing the send.
 *
 * Gas: the node estimate plus the buffer, never below the call type's floor (Mezo's estimates can be far too low).
 * A receipt that reverted out of gas is retried once with double the limit, after a fresh estimate shows the call
 * still succeeds. A transaction that stays unmined is replaced at the same nonce with higher fees; if it is still
 * unmined after every replacement, the next send takes over that nonce (again with higher fees) instead of queueing
 * behind it.
 */
export class TxSender {
  private tail: Promise<unknown> = Promise.resolve();
  /** Outcome counts per call kind. */
  readonly counts: Record<string, Partial<Record<TxOutcome, number>>> = {};
  /** Latest outcomes of any kind, newest last. */
  readonly recent: TxOutcome[] = [];
  /** Since when the account has had a transaction stuck unmined (null when none). */
  stuckSince: number | null = null;
  lastError: string | null = null;
  /** Nonce after this sender's last mined transaction. */
  private nextNonce: number | null = null;
  /** A transaction left unmined after every replacement: the next send replaces it. */
  private stuck: { nonce: number; fees: Fees } | null = null;
  /** Consecutive health checks that found the stuck nonce gone from the pending pool without being mined. */
  private evictedChecks = 0;
  /** The oldest pending transaction when it is not ours (a previous run, another process with the key), and since when. */
  private foreign: { nonce: number; since: number } | null = null;
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(
    readonly network: NetworkName,
    private readonly client: PublicClient,
    readonly wallet: Wallet,
    private readonly opts: TxSenderOptions,
  ) {
    this.now = opts.now ?? Date.now;
    // Every poll reads one receipt per hash sent at the nonce: never faster than once a second on a public RPC.
    this.pollMs = Math.max(1, opts.pollMs ?? Math.max(MIN_POLL_MS, client.pollingInterval || DEFAULT_POLL_MS));
  }

  get address(): Hex {
    return this.wallet.account.address;
  }

  /** Sends a writeContract-style request (address, abi, functionName, args, value) and waits for its receipt. */
  send(request: object, options: SendOptions): Promise<Sent> {
    const run = this.tail.then(() => this.sendNow(request as WriteRequest, options));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Share of reverted transactions among the recent ones (null until there are a few). */
  revertRate(): number | null {
    if (this.recent.length < 5) return null;
    return this.recent.filter((o) => o === 'reverted' || o === 'out_of_gas').length / this.recent.length;
  }

  /**
   * What became of a request sent earlier at `nonce` (by this process or a previous run), from chain state. The nonce
   * count is read before the receipts, so a receipt is never older than the count it is compared with. Throws when
   * the receipts cannot be read: try again later.
   */
  async settle(nonce: number, hashes: Hex[]): Promise<Settlement> {
    const confirmed = await this.confirmedCount();
    const { receipt, unreadable } = await this.findReceipt(hashes);
    if (receipt) return { status: 'mined', receipt };
    if (unreadable) throw new Error(`receipts of nonce ${nonce} on ${this.network} could not be read`);
    return confirmed > nonce ? { status: 'dropped' } : { status: 'pending' };
  }

  /**
   * Clears the stuck state once its nonce has been mined (by the stuck transaction or by one that replaced it), also
   * when nothing else is sent afterwards. The health monitor calls this on every tick.
   */
  async refreshStuck(): Promise<void> {
    const stuck = this.stuck;
    if (!stuck) return;
    const [confirmed, pending] = await Promise.all([this.confirmedCount(), this.client.getTransactionCount({ address: this.address, blockTag: 'pending' })]);
    if (this.stuck !== stuck) return;
    if (confirmed > stuck.nonce) {
      this.clearStuck('the stuck nonce has been mined', stuck.nonce);
      return;
    }
    // Evicted unmined (e.g. during a fee spike): the nonce is free again, so the next send simply reuses it.
    this.evictedChecks = pending <= stuck.nonce ? this.evictedChecks + 1 : 0;
    if (this.evictedChecks >= 2) this.clearStuck('the stuck transaction left the mempool unmined', stuck.nonce);
  }

  private clearStuck(message: string, nonce: number): void {
    this.stuck = null;
    this.stuckSince = null;
    this.evictedChecks = 0;
    this.opts.log('tx', message, { network: this.network, nonce });
  }

  private async sendNow(request: WriteRequest, { kind, floor = 0n, onBroadcast }: SendOptions): Promise<Sent> {
    try {
      const gas = gasWithBuffer(await this.estimate(request), floor);
      let sent = await this.broadcast(request, gas, kind, onBroadcast);
      if (ranOutOfGas(sent.receipt, gas)) {
        this.record(kind, 'out_of_gas');
        // Re-estimate first: a call that now reverts for another reason (e.g. someone else liquidated) is not resent.
        const again = await this.estimate(request).catch(() => null);
        if (again === null) {
          this.opts.log('tx', `${kind} ran out of gas and now reverts; not retried`, { network: this.network, txHash: sent.hash, gas: String(gas) });
          return sent;
        }
        const retryGas = atLeast(gas * 2n, gasWithBuffer(again, floor));
        this.opts.log('tx', `${kind} ran out of gas; retrying with double the limit`, {
          network: this.network,
          txHash: sent.hash,
          gasUsed: String(sent.receipt.gasUsed),
          gas: String(gas),
          retryGas: String(retryGas),
        });
        sent = await this.broadcast(request, retryGas, kind, onBroadcast);
      }
      this.record(kind, sent.receipt.status === 'success' ? 'success' : 'reverted');
      return sent;
    } catch (err) {
      this.record(kind, err instanceof StuckTransactionError ? 'stuck' : err instanceof NonceConsumedError ? 'unknown' : 'failed');
      this.lastError = publicError(err);
      throw err;
    }
  }

  private estimate(request: WriteRequest): Promise<bigint> {
    // Loosely typed on purpose: callers pass fully typed writeContract/simulateContract requests, whose viem
    // generics do not survive spreading.
    return this.client.estimateContractGas({ ...request, account: this.wallet.account } as never);
  }

  /** EIP-1559 fees where the chain has a base fee, else a legacy gas price. */
  private async fees(): Promise<Fees> {
    try {
      const f = await this.client.estimateFeesPerGas();
      if (f.maxFeePerGas !== undefined && f.maxPriorityFeePerGas !== undefined)
        return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
      if (f.gasPrice !== undefined) return { gasPrice: f.gasPrice };
    } catch (err) {
      if (!(err instanceof Eip1559FeesNotSupportedError)) throw err;
    }
    return { gasPrice: await this.client.getGasPrice() };
  }

  private confirmedCount(): Promise<number> {
    return this.client.getTransactionCount({ address: this.address, blockTag: 'latest' });
  }

  /** Every nonce up to `nonce` is used now: a stuck one among them is settled. */
  private nonceUsed(nonce: number): void {
    this.nextNonce = Math.max(this.nextNonce ?? 0, nonce + 1);
    if (this.stuck && this.stuck.nonce <= nonce) {
      this.stuck = null;
      this.stuckSince = null;
    }
  }

  /**
   * Nonce and starting fees for the next transaction. Normally the next free nonce. When the oldest pending nonce
   * is our stuck transaction, it is taken over at once; when it belongs to another sender (a previous run of the
   * agent, or another process using the key) and stays pending past the receipt timeout, it is taken over too,
   * instead of queueing every later transaction behind it.
   */
  private async slot(): Promise<{ nonce: number; fees: Fees }> {
    const address = this.address;
    const [current, confirmed, pending] = await Promise.all([
      this.fees(),
      this.client.getTransactionCount({ address, blockTag: 'latest' }),
      this.client.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    if (this.stuck && confirmed > this.stuck.nonce) {
      this.stuck = null; // mined after all
      this.stuckSince = null;
    }
    if (this.stuck?.nonce === confirmed) return { nonce: confirmed, fees: bumped(this.stuck.fees, current) };
    // Ours are settled before the next is prepared (or recorded as stuck): a pending one at `confirmed` is someone else's.
    if (pending > confirmed) {
      const now = this.now();
      if (this.foreign?.nonce !== confirmed) this.foreign = { nonce: confirmed, since: now };
      else if (now - this.foreign.since > this.opts.receiptTimeoutMs) {
        this.foreign.since = now; // one takeover per timeout
        this.opts.log('tx', 'taking over a transaction another sender left pending', { network: this.network, nonce: confirmed });
        return { nonce: confirmed, fees: bumped(current, current) };
      }
    } else this.foreign = null;
    return { nonce: Math.max(pending, this.nextNonce ?? 0), fees: current };
  }

  /** Signs the call locally, so its hash is known before it leaves, whatever the node answers to the broadcast. */
  private async sign(request: WriteRequest, gas: bigint, nonce: number, fees: Fees): Promise<{ raw: Hex; hash: Hex }> {
    const { account, chain } = this.wallet;
    if (account.type !== 'local') throw new Error('the keeper account must sign locally (KEEPER_PRIVATE_KEY)');
    const call = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as never);
    const base = { chainId: chain.id, to: request.address, data: concatHex([call, request.dataSuffix ?? '0x']), gas, nonce, value: request.value };
    const tx: TransactionSerializable = 'gasPrice' in fees ? { ...base, type: 'legacy', gasPrice: fees.gasPrice } : { ...base, type: 'eip1559', ...fees };
    // The chain's own serializer where it has one (OP-stack chains such as Base), as viem's sendTransaction uses.
    const serializer = chain.serializers?.transaction as SerializeTransactionFn<TransactionSerializable> | undefined;
    const raw = await account.signTransaction(tx, { serializer });
    return { raw, hash: keccak256(raw) };
  }

  /**
   * Sends at the account's next nonce and waits for a receipt of any transaction sent at it, replacing the
   * transaction with higher fees while it stays unmined. Once anything may have reached a node, a failure is a
   * SentTransactionError naming every hash sent at the nonce, never an ordinary error.
   */
  private async broadcast(request: WriteRequest, gas: bigint, kind: string, onBroadcast?: SendOptions['onBroadcast']): Promise<Sent> {
    const { nonce, fees: initialFees } = await this.slot();
    let fees = initialFees;
    const hashes: Hex[] = [];
    const maxReplacements = this.opts.maxReplacements ?? DEFAULT_MAX_REPLACEMENTS;
    /** Whether a transaction of this request may have reached a node (until then a failure is an ordinary error). */
    let out = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const { raw, hash } = await this.sign(request, gas, nonce, fees);
        hashes.push(hash);
        onBroadcast?.({ network: this.network, nonce, hashes: [...hashes] });
        try {
          out = true;
          await this.wallet.sendRawTransaction({ serializedTransaction: raw });
        } catch (err) {
          const said = errorText(err);
          if (attempt === 0 && REFUSED.test(said) && !(await this.isKnown(hash))) {
            // The node refused it, and nothing of this request is out there: an ordinary failure.
            out = false;
            if (NONCE_USED.test(said)) {
              // This sender's view of the account was behind (another sender, or a lagging replica): resync next time.
              this.nextNonce = null;
              this.stuck = null;
              this.stuckSince = null;
            }
            throw err;
          }
          // It may have arrived after all (a timeout, a dropped connection, "already known" from a fallback RPC), or a
          // fee bump was refused while an earlier attempt is pending or mined: every hash at this nonce is watched.
          this.opts.log('tx', `${kind} broadcast not confirmed by the node; watching every transaction at its nonce`, {
            network: this.network,
            nonce,
            txHash: hash,
            error: publicError(err),
          });
        }
        const seen = await this.watch(nonce, hashes);
        if ('receipt' in seen) {
          this.nonceUsed(nonce);
          return { hash: seen.receipt.transactionHash, receipt: seen.receipt, gas, nonce };
        }
        if ('consumed' in seen) {
          this.nonceUsed(nonce);
          throw new NonceConsumedError(this.network, nonce, hashes);
        }
        if (attempt >= maxReplacements) {
          this.stuck = { nonce, fees };
          this.stuckSince ??= this.now();
          throw new StuckTransactionError(this.network, nonce, hashes);
        }
        fees = bumped(fees, await this.fees().catch(() => fees));
        this.opts.log('tx', `${kind} unmined after ${Math.round(this.opts.receiptTimeoutMs / 1000)} s; re-sending with higher fees`, {
          network: this.network,
          nonce,
          txHash: hash,
        });
      }
    } catch (err) {
      if (!out || err instanceof SentTransactionError) throw err;
      // Something left already (an unexpected error while signing a bump or watching): it may still be mined.
      this.stuck = { nonce, fees };
      this.stuckSince ??= this.now();
      throw new StuckTransactionError(this.network, nonce, hashes, publicError(err));
    }
  }

  /**
   * Polls the receipts of every transaction sent at `nonce` for one receipt timeout. A receipt of one of them settles
   * the request; the nonce moving on without one means another transaction took it. Failed lookups (rate limits, an
   * RPC outage) are polled again instead of failing the send.
   */
  private async watch(nonce: number, hashes: Hex[]): Promise<{ receipt: TransactionReceipt } | { consumed: true } | { pending: true }> {
    const polls = Math.max(1, Math.ceil(this.opts.receiptTimeoutMs / this.pollMs));
    // Counted in polls, not wall time, so a frozen test clock cannot stall it.
    const recheck = Math.max(CONSUMED_RECHECKS, Math.ceil(Math.min(CONSUMED_GRACE_MS, this.opts.receiptTimeoutMs) / this.pollMs));
    let taken = 0;
    for (let poll = 1; ; poll++) {
      const { receipt, unreadable } = await this.findReceipt(hashes);
      if (receipt) return { receipt };
      const confirmed = await this.confirmedCount().catch(() => null);
      // The nonce moved without a receipt of ours: keep looking for a while (a lagging receipt endpoint) before concluding.
      if (confirmed !== null && confirmed > nonce && !unreadable) taken += 1;
      if (taken > recheck) return { consumed: true };
      // Past the timeout: give up on this attempt, unless the nonce moved and that verdict is still maturing.
      if (poll >= polls && (taken === 0 || poll >= polls + 2 * recheck)) return { pending: true };
      await sleep(this.pollMs);
    }
  }

  /** The receipt of one of `hashes` (newest first), and whether any lookup failed for a reason other than "not found". */
  private async findReceipt(hashes: Hex[]): Promise<{ receipt: TransactionReceipt | null; unreadable: boolean }> {
    let unreadable = false;
    for (const hash of [...hashes].reverse()) {
      try {
        const receipt = await this.client.getTransactionReceipt({ hash });
        // Only a receipt of a transaction this request sent settles it, never another one at the same nonce.
        if (receipt && sameHash(receipt.transactionHash, hash)) return { receipt, unreadable: false };
      } catch (err) {
        if (!(err instanceof TransactionReceiptNotFoundError)) unreadable = true;
      }
    }
    return { receipt: null, unreadable };
  }

  /** Whether the chain knows `hash` (mined or pending). An RPC that cannot answer proves nothing: true. */
  private async isKnown(hash: Hex): Promise<boolean> {
    const { receipt, unreadable } = await this.findReceipt([hash]);
    if (receipt || unreadable) return true;
    try {
      await this.client.getTransaction({ hash });
      return true;
    } catch (err) {
      return !(err instanceof TransactionNotFoundError);
    }
  }

  private record(kind: string, outcome: TxOutcome): void {
    const c = (this.counts[kind] ??= {});
    c[outcome] = (c[outcome] ?? 0) + 1;
    this.recent.push(outcome);
    if (this.recent.length > RECENT_OUTCOMES) this.recent.shift();
  }
}
