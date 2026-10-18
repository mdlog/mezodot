import {
  BaseError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
  encodeFunctionData,
  isHex,
  type Abi,
  type Address,
  type EncodeFunctionDataParameters,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { GAS_FLOOR, SOURCE_TAG, gasWithBuffer } from '@mezodot/sdk';
import { explainError } from '../lib/errors';

/**
 * Sequencing of multi-transaction actions, kept free of React and wagmi so it can be tested with fakes:
 * build each step just in time, switch chains, size gas, sign, wait for the receipt, and report which
 * steps landed when one fails. `useTx` (tx.ts) wires it to the wallet, the app-wide lock and toasts.
 */

/** One wallet transaction. `request` is built lazily so price updates are fetched just in time. */
export type TxStep = {
  label: string;
  chainId: number;
  /** Minimum gas limit for this call type (GAS_FLOOR); price updates the request carries add their own. */
  gasFloor?: bigint;
  // Loosely typed on purpose: every step is a fully-typed `writeContract` request built by actions.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: () => Promise<any | null>;
};

/** The parts of a `writeContract` request the runner looks at. */
export type TxRequest = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

export type TxClient = Pick<PublicClient, 'estimateContractGas' | 'waitForTransactionReceipt' | 'simulateContract'>;

/** What the runner needs from the wallet and the chains (wagmi in the app, fakes in tests). */
export type TxDriver = {
  /** The connected account and the wallet's current chain, read again before every step. */
  wallet(): { address: Address | undefined; chainId: number | undefined };
  switchChain(chainId: number): Promise<void>;
  client(chainId: number): TxClient | undefined;
  write(request: TxRequest, chainId: number, gas: bigint): Promise<Hash>;
  /** One sentence for a failure; defaults to explainError. */
  explain?(err: unknown, request: TxRequest | null): string;
};

export type StepPhase = 'preparing' | 'switching' | 'signing' | 'confirming';

export type RunHooks = {
  /** `attempt` is 1 when the step is sent again after running out of gas. */
  onPhase?(index: number, phase: StepPhase, attempt: number): void;
  /** The step's transaction hash, as soon as the wallet returns it (before it is mined). */
  onSubmitted?(index: number, hash: Hash): void;
  onStepDone?(index: number, status: 'done' | 'skipped'): void;
  /** Aborting stops waiting for the current receipt; the transaction itself may still land. */
  signal?: AbortSignal;
  receiptTimeoutMs?: number;
};

export type StepStatus = 'done' | 'skipped' | 'failed' | 'pending' | 'not-sent';
export type StepReport = { label: string; chainId: number; status: StepStatus; hash?: Hash };

export type RunOutcome =
  | { ok: true; receipts: TransactionReceipt[]; steps: StepReport[] }
  | {
      ok: false;
      error: string;
      /** The wallet declined a signature: nothing to report beyond the steps that already landed. */
      rejected: boolean;
      steps: StepReport[];
      /** Set when the user stopped waiting for a sent transaction that may still be mined. */
      pending: { hash: Hash; chainId: number } | null;
    };

/** A dropped transaction would otherwise be waited on forever; the run reports it as still pending. */
export const RECEIPT_TIMEOUT_MS = 10 * 60_000;

/** A reverted transaction that used this share of its limit ran out of gas. */
const OUT_OF_GAS_BPS = 9_800n;

// --- Price updates attached by actions.ts ---------------------------------------------------------------

const PRICE_UPDATES = new WeakMap<readonly Hex[], { relayError: string | null }>();

/** Registers a `bytes[] priceUpdate` array, with why it is empty when the agent relay could not be reached. */
export function markPriceUpdates(updates: Hex[], relayError: string | null = null): Hex[] {
  PRICE_UPDATES.set(updates, { relayError });
  return updates;
}

/** The price updates `request` carries, if it takes any: the registered array, else any array of tagged hex. */
export function priceUpdatesIn(request: TxRequest | null | undefined): { updates: readonly Hex[]; relayError: string | null } | null {
  const arrays = (request?.args ?? []).filter((a): a is readonly unknown[] => Array.isArray(a));
  for (const arg of arrays) {
    const meta = PRICE_UPDATES.get(arg as readonly Hex[]);
    if (meta) return { updates: arg as readonly Hex[], relayError: meta.relayError };
  }
  const tagged = arrays.find((a) => a.length > 0 && a.every((u) => typeof u === 'string' && isHex(u)));
  return tagged ? { updates: tagged as readonly Hex[], relayError: null } : null;
}

const sourceTag = (update: Hex): number => parseInt(update.slice(2, 4), 16);
const maxOf = (values: bigint[]) => values.reduce((a, b) => (b > a ? b : a), 0n);

/** Gas floor for a step: its own, a Supra proof's, or one Pyth update's per update, whichever is largest. */
export function gasFloorFor(step: Pick<TxStep, 'gasFloor'>, request: TxRequest | null): bigint {
  const tags = (priceUpdatesIn(request)?.updates ?? []).map(sourceTag);
  const pyth = BigInt(tags.filter((t) => t === SOURCE_TAG.PYTH).length);
  return maxOf([step.gasFloor ?? 0n, tags.includes(SOURCE_TAG.SUPRA) ? GAS_FLOOR.supraProof : 0n, pyth * GAS_FLOOR.pythUpdate]);
}

export const ranOutOfGas = (receipt: Pick<TransactionReceipt, 'status' | 'gasUsed'>, gasLimit: bigint): boolean =>
  receipt.status === 'reverted' && receipt.gasUsed * 10_000n >= gasLimit * OUT_OF_GAS_BPS;

// --- Gas limits ------------------------------------------------------------------------------------------

/** Intrinsic gas of a call with `data`: the 21k base plus calldata (EIP-2028: 4 per zero byte, 16 per other byte). */
export function intrinsicGas(data: Hex): bigint {
  let gas = 21_000n;
  for (let i = 2; i < data.length; i += 2) gas += data.slice(i, i + 2) === '00' ? 4n : 16n;
  return gas;
}

/**
 * Execution gas below which an estimate cannot be right for any Mezodot call (even an approve writes storage and
 * logs): some Mezo RPC backends answer eth_estimateGas as if no contract code ran (intrinsic plus calldata only).
 */
export const MIN_EXECUTION_GAS = 5_000n;

/** Limit used when the node keeps ignoring the contract code: the costliest user call measured (a Supra-proof check). */
export const FALLBACK_GAS = GAS_FLOOR.supraProof;

function requestIntrinsicGas(request: TxRequest): bigint {
  try {
    return intrinsicGas(encodeFunctionData(request as EncodeFunctionDataParameters));
  } catch {
    return 21_000n; // not encodable here (the node still estimates it): only the base cost is known
  }
}

/**
 * Gas limit for `request`: max(floor, estimate × 1.3 + 20k), and at least `minimum` (twice a limit that ran out).
 * An estimate with almost no execution gas is asked for once more (the public RPC is load-balanced); if the
 * answer is still empty, the limit falls back to FALLBACK_GAS instead of a transaction that is sure to run out.
 */
export async function gasLimitFor(client: TxClient, step: Pick<TxStep, 'gasFloor'>, request: TxRequest, account: Address, minimum = 0n): Promise<bigint> {
  const estimate = () => client.estimateContractGas({ ...request, account } as Parameters<TxClient['estimateContractGas']>[0]);
  const plausible = requestIntrinsicGas(request) + MIN_EXECUTION_GAS;
  let gas = await estimate();
  if (gas < plausible) gas = await estimate();
  return gasWithBuffer(gas, maxOf([gasFloorFor(step, request), minimum, gas < plausible ? FALLBACK_GAS : 0n]));
}

export const isUserRejection = (err: unknown): boolean => err instanceof BaseError && Boolean(err.walk((e) => e instanceof UserRejectedRequestError));

// --- Runner -------------------------------------------------------------------------------------------------

class StillPending extends Error {
  constructor(readonly hash: Hash) {
    super('Still waiting for the transaction to confirm');
  }
}

/** Waits for `promise`, or rejects with `onAbort()` once `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => Error): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function waitForReceipt(client: TxClient, hash: Hash, hooks: RunHooks): Promise<TransactionReceipt> {
  let replacement: 'replaced' | 'repriced' | 'cancelled' | undefined;
  const wait = client.waitForTransactionReceipt({
    hash,
    timeout: hooks.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS,
    onReplaced: (r) => {
      replacement = r.reason;
    },
  });
  let receipt: TransactionReceipt;
  try {
    receipt = await abortable(wait, hooks.signal, () => new StillPending(hash));
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) throw new StillPending(hash);
    throw err;
  }
  // A speed-up ("repriced") still does the same thing; a cancel or a different transaction does not.
  if (replacement === 'cancelled') throw new Error('The transaction was cancelled in the wallet');
  if (replacement === 'replaced') throw new Error('The transaction was replaced in the wallet by a different one');
  return receipt;
}

/** Re-runs a reverted call at its block to recover the revert reason (best effort). */
async function revertReason(client: TxClient, request: TxRequest, account: Address, receipt: TransactionReceipt): Promise<unknown> {
  try {
    await client.simulateContract({ ...request, account, blockNumber: receipt.blockNumber } as Parameters<TxClient['simulateContract']>[0]);
    return null;
  } catch (err) {
    return err;
  }
}

/** A failure whose message is already final (an on-chain revert, explained once). */
class StepFailed extends Error {}

const gasText = (gas: bigint) => gas.toLocaleString('en-US');

/** Runs `steps` in order and reports what landed; never throws. */
export async function runSteps(driver: TxDriver, steps: readonly TxStep[], hooks: RunHooks = {}): Promise<RunOutcome> {
  const reports: StepReport[] = steps.map((s) => ({ label: s.label, chainId: s.chainId, status: 'not-sent' }));
  const receipts: TransactionReceipt[] = [];
  const explain = (err: unknown, request: TxRequest | null) => (driver.explain ? driver.explain(err, request) : explainError(err));
  let request: TxRequest | null = null;

  for (const [index, step] of steps.entries()) {
    const report = reports[index];
    let lastGas = 0n;
    try {
      for (let attempt = 0; ; attempt++) {
        hooks.onPhase?.(index, 'preparing', attempt);
        request = null; // a failure while building is explained without the previous step's request
        request = (await step.request()) as TxRequest | null;
        if (!request) {
          report.status = 'skipped'; // e.g. the allowance already covers the amount
          hooks.onStepDone?.(index, 'skipped');
          break;
        }
        let { address, chainId } = driver.wallet();
        if (!address) throw new Error('Connect a wallet to continue');
        if (chainId !== step.chainId) {
          hooks.onPhase?.(index, 'switching', attempt);
          await driver.switchChain(step.chainId);
          ({ address, chainId } = driver.wallet());
          if (!address || chainId !== step.chainId) throw new Error('Your wallet did not switch networks; switch it and try again');
        }
        const client = driver.client(step.chainId);
        if (!client) throw new Error(`No RPC client for chain ${step.chainId}`);
        // Explicit gas limit: Mezo's estimates can be exact to the unit, or ignore contract code entirely.
        const gas = await gasLimitFor(client, step, request, address, attempt > 0 ? lastGas * 2n : 0n);

        hooks.onPhase?.(index, 'signing', attempt);
        const hash = await driver.write(request, step.chainId, gas);
        report.hash = hash;
        hooks.onSubmitted?.(index, hash);
        hooks.onPhase?.(index, 'confirming', attempt);
        const receipt = await waitForReceipt(client, hash, hooks);
        if (receipt.status === 'success') {
          receipts.push(receipt);
          report.status = 'done';
          hooks.onStepDone?.(index, 'done');
          break;
        }
        if (ranOutOfGas(receipt, gas)) {
          // Nothing happened on-chain but the fee: send it once more with twice the limit.
          if (attempt === 0) {
            lastGas = gas;
            continue;
          }
          throw new StepFailed(`${step.label} ran out of gas on-chain (${gasText(receipt.gasUsed)} of ${gasText(gas)} gas)`);
        }
        const reason = await revertReason(client, request, address, receipt);
        throw new StepFailed(`${step.label} reverted on-chain${reason ? `: ${explain(reason, request)}` : ''}`);
      }
    } catch (err) {
      if (err instanceof StillPending) {
        report.status = 'pending';
        return {
          ok: false,
          error: `Still waiting for "${step.label}" to confirm. It may still land: follow it in the explorer`,
          rejected: false,
          steps: reports,
          pending: { hash: err.hash, chainId: step.chainId },
        };
      }
      report.status = report.hash ? 'failed' : 'not-sent';
      const message = err instanceof StepFailed ? err.message : explain(err, request);
      return { ok: false, error: message, rejected: isUserRejection(err), steps: reports, pending: null };
    }
  }
  return { ok: true, receipts, steps: reports };
}
