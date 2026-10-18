import { gasWithBuffer, type NetworkName } from '@mezodot/sdk';
import { Eip1559FeesNotSupportedError, WaitForTransactionReceiptTimeoutError, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import type { Logger, Wallet } from './context';
import { publicError } from './errors';

export type TxOutcome = 'success' | 'reverted' | 'out_of_gas' | 'stuck' | 'failed';

export type SendOptions = {
  /** Call type for logs and metrics, e.g. 'pyth-push', 'relay-deposit', 'liquidation'. */
  kind: string;
  /** Minimum gas limit for this call type (GAS_FLOOR from the SDK). */
  floor?: bigint;
};

export type Sent = { hash: Hex; receipt: TransactionReceipt; gas: bigint; nonce: number };

/** A reverted receipt that used at least this share of its gas limit (bps) ran out of gas. */
const OUT_OF_GAS_BPS = 9_800n;
/** Fee multiplier for a replacement, in bps (nodes require at least +10% on every fee field). */
const FEE_BUMP_BPS = 13_000n;
const DEFAULT_MAX_REPLACEMENTS = 2;
/** Outcomes remembered for the revert-rate health check. */
const RECENT_OUTCOMES = 20;
/** Node errors meaning the nonce this sender picked is already used (its view of the account was behind). */
const NONCE_USED = /nonce too low|nonce has already been used|already known|invalid nonce|replacement transaction underpriced/i;

export const ranOutOfGas = (receipt: Pick<TransactionReceipt, 'status' | 'gasUsed'>, gasLimit: bigint): boolean =>
  receipt.status === 'reverted' && receipt.gasUsed * 10_000n >= gasLimit * OUT_OF_GAS_BPS;

export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };

const scale = (v: bigint) => (v * FEE_BUMP_BPS) / 10_000n + 1n;
const atLeast = (a: bigint, b: bigint) => (a > b ? a : b);

/** Fees for a replacement: the previous ones bumped, and never below what the network asks for now. */
export function bumped(previous: Fees, current: Fees): Fees {
  if ('gasPrice' in previous) return { gasPrice: atLeast(scale(previous.gasPrice), 'gasPrice' in current ? current.gasPrice : current.maxFeePerGas) };
  const now = 'gasPrice' in current ? { maxFeePerGas: current.gasPrice, maxPriorityFeePerGas: current.gasPrice } : current;
  return {
    maxFeePerGas: atLeast(scale(previous.maxFeePerGas), now.maxFeePerGas),
    maxPriorityFeePerGas: atLeast(scale(previous.maxPriorityFeePerGas), now.maxPriorityFeePerGas),
  };
}

/** A transaction that stayed unmined through every replacement. */
export class StuckTransactionError extends Error {
  constructor(
    readonly network: NetworkName,
    readonly nonce: number,
    readonly hashes: Hex[],
  ) {
    super(`transaction with nonce ${nonce} on ${network} is still unmined after ${hashes.length} attempts (${hashes.at(-1)})`);
    this.name = 'StuckTransactionError';
  }
}

export type TxSenderOptions = {
  /** How long one attempt may stay unmined before it is replaced with higher fees. */
  receiptTimeoutMs: number;
  log: Logger;
  maxReplacements?: number;
  now?: () => number;
};

/**
 * The keeper account's only way to send transactions on one chain. Sends are serialized, so the relayer, the
 * liquidator, the Pyth pusher and MCP tools never prepare two transactions with the same nonce; each one waits
 * for its receipt (bounded) before the next is prepared. The nonce is the node's pending count, never below the
 * one after this sender's last mined transaction (a lagging RPC replica can report an older count).
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
  /** The oldest pending transaction when it is not ours (a previous run, another process with the key), and since when. */
  private foreign: { nonce: number; since: number } | null = null;
  private readonly now: () => number;

  constructor(
    readonly network: NetworkName,
    private readonly client: PublicClient,
    readonly wallet: Wallet,
    private readonly opts: TxSenderOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  get address(): Hex {
    return this.wallet.account.address;
  }

  /** Sends a writeContract-style request (address, abi, functionName, args, value) and waits for its receipt. */
  send(request: object, options: SendOptions): Promise<Sent> {
    const run = this.tail.then(() => this.sendNow(request, options));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Share of reverted transactions among the recent ones (null until there are a few). */
  revertRate(): number | null {
    if (this.recent.length < 5) return null;
    return this.recent.filter((o) => o === 'reverted' || o === 'out_of_gas').length / this.recent.length;
  }

  private async sendNow(request: object, { kind, floor = 0n }: SendOptions): Promise<Sent> {
    try {
      const gas = gasWithBuffer(await this.estimate(request), floor);
      let sent = await this.broadcast(request, gas, kind);
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
        sent = await this.broadcast(request, retryGas, kind);
      }
      this.record(kind, sent.receipt.status === 'success' ? 'success' : 'reverted');
      return sent;
    } catch (err) {
      this.record(kind, err instanceof StuckTransactionError ? 'stuck' : 'failed');
      this.lastError = publicError(err);
      throw err;
    }
  }

  private estimate(request: object): Promise<bigint> {
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
    // Ours are mined before the next is prepared (or recorded as stuck): a pending one at `confirmed` is someone else's.
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

  /** Sends at the account's next nonce and waits for the receipt, replacing the transaction while it stays unmined. */
  private async broadcast(request: object, gas: bigint, kind: string): Promise<Sent> {
    const address = this.address;
    const { nonce, fees: initialFees } = await this.slot();
    let fees = initialFees;
    const hashes: Hex[] = [];
    const write = async () => {
      const hash = await this.wallet.writeContract({ ...request, gas, nonce, ...fees } as never);
      hashes.push(hash);
      return hash;
    };
    const mined = (receipt: TransactionReceipt): Sent => {
      this.nextNonce = Math.max(this.nextNonce ?? 0, nonce + 1);
      if (this.stuck?.nonce === nonce) this.stuck = null;
      this.stuckSince = null;
      return { hash: receipt.transactionHash ?? hashes.at(-1)!, receipt, gas, nonce };
    };

    let hash: Hex;
    try {
      hash = await write();
    } catch (err) {
      // This sender's view of the account was behind (another sender, or a lagging replica): resync next time.
      if (NONCE_USED.test(err instanceof Error ? err.message : String(err))) {
        this.nextNonce = null;
        this.stuck = null;
      }
      throw err;
    }
    const maxReplacements = this.opts.maxReplacements ?? DEFAULT_MAX_REPLACEMENTS;
    for (let replacements = 0; ; replacements++) {
      try {
        return mined(await this.client.waitForTransactionReceipt({ hash, timeout: this.opts.receiptTimeoutMs }));
      } catch (err) {
        if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
      }
      // Mined after all (a lagging receipt endpoint, or an earlier attempt at this nonce won)?
      const late = await this.findReceipt(hashes);
      if (late) return mined(late);
      const confirmed = await this.client.getTransactionCount({ address, blockTag: 'latest' });
      if (confirmed > nonce) {
        this.nextNonce = Math.max(this.nextNonce ?? 0, nonce + 1);
        throw new Error(`nonce ${nonce} on ${this.network} was consumed, but no receipt was found for ${hashes.join(', ')}`);
      }
      if (replacements >= maxReplacements) {
        this.stuck = { nonce, fees };
        this.stuckSince ??= this.now();
        throw new StuckTransactionError(this.network, nonce, hashes);
      }
      fees = bumped(fees, await this.fees());
      this.opts.log('tx', `${kind} unmined after ${Math.round(this.opts.receiptTimeoutMs / 1000)} s; re-sending with higher fees`, {
        network: this.network,
        nonce,
        txHash: hash,
      });
      try {
        hash = await write();
      } catch (err) {
        // "nonce too low": the previous attempt got mined while we were deciding.
        const raced = await this.findReceipt(hashes);
        if (raced) return mined(raced);
        throw err;
      }
    }
  }

  private async findReceipt(hashes: Hex[]): Promise<TransactionReceipt | null> {
    for (const hash of hashes) {
      const receipt = await this.client.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) return receipt;
    }
    return null;
  }

  private record(kind: string, outcome: TxOutcome): void {
    const c = (this.counts[kind] ??= {});
    c[outcome] = (c[outcome] ?? 0) + 1;
    this.recent.push(outcome);
    if (this.recent.length > RECENT_OUTCOMES) this.recent.shift();
  }
}
