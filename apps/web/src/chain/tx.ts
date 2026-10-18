import { useCallback, useId } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfig } from 'wagmi';
import { getAccount, getPublicClient, switchChain, writeContract } from 'wagmi/actions';
import { BaseError, ContractFunctionRevertedError, isAddressEqual, keccak256, slice, toHex, type Address, type Hash, type TransactionReceipt } from 'viem';
import { explainError } from '../lib/errors';
import { useTxState, type ActiveTx } from '../state/TxContext';
import { useUi } from '../state/UiContext';
import { HUB, SPOKES, explorerTx } from './env';
import { priceUpdatesIn, runSteps, type StepReport, type TxClient, type TxDriver, type TxRequest, type TxStep } from './runner';

export { explainError };
export type { TxStep };

export type TxResult = { ok: true; receipts: TransactionReceipt[] } | { ok: false; pending?: { hash: Hash; chainId: number } };

export type RunOptions = {
  /** Called with each step's hash as soon as the wallet returns it, before the receipt (e.g. to record a flight). */
  onSubmitted?: (step: TxStep, hash: Hash) => void;
};

const networkOf = (chainId: number) => [HUB, ...SPOKES].find((n) => n.chain.id === chainId);
const networkLabel = (chainId: number) => networkOf(chainId)?.label ?? `chain ${chainId}`;

/** Explorer link for a step's transaction, when its network has an explorer. */
export const stepTxUrl = (step: Pick<StepReport, 'chainId' | 'hash'>): string | null => {
  const network = networkOf(step.chainId);
  return network && step.hash ? explorerTx(network, step.hash) : null;
};

// --- Error text with the context only the runner has (which contract, which prices were missing) ----------

const ENFORCED_PAUSE = slice(keccak256(toHex('EnforcedPause()')), 0, 4);

const contractRevert = (err: unknown): ContractFunctionRevertedError | null =>
  err instanceof BaseError ? (err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;

const isEnforcedPause = (err: unknown): boolean => {
  const revert = contractRevert(err);
  return revert?.data?.errorName === 'EnforcedPause' || revert?.signature === ENFORCED_PAUSE || Boolean(revert?.raw?.startsWith(ENFORCED_PAUSE));
};

/** What a pause blocks depends on the contract that is paused (see each contract's pause()). */
export function pausedMessage(target: Address | undefined): string {
  const c = HUB.deployment?.contracts;
  const is = (a: Address | undefined) => Boolean(a && target && isAddressEqual(a, target));
  if (c && is(c.vaultManager)) return 'Borrowing is paused on Mezodot right now. Repaying, withdrawing and adding collateral still work';
  if (c && (is(c.pMUSD) || is(c.pMEZO))) {
    const symbol = is(c.pMUSD) ? 'MUSD' : 'MEZO';
    return `The ${symbol} pool is paused: new supply and borrows are blocked. Withdrawals and repayments still work`;
  }
  if (c && (is(c.leverageManager) || is(c.swapLeverageManager))) {
    return 'Opening leveraged positions is paused right now (a pool or borrowing is paused). Closing positions still works';
  }
  const spoke = SPOKES.find((s) => is(s.deployment?.contracts.spokeGateway));
  if (spoke) return `The ${spoke.label} gateway is paused: new locks are blocked. Releases still work`;
  return 'This action is paused right now. Repaying, withdrawing and closing positions stay open';
}

export function explainTxError(err: unknown, request: TxRequest | null): string {
  const message = isEnforcedPause(err) ? pausedMessage(request?.address) : explainError(err);
  // A relay outage only matters when the contract refused the call, which may have needed those prices (a stale
  // feed, or collateral counted as $0); a declined signature or a network error has nothing to do with it.
  const relayError = contractRevert(err) ? priceUpdatesIn(request)?.relayError : null;
  return relayError ? `${message}. Fresh prices could not be attached (${relayError}); retry once the Mezodot agent is reachable` : message;
}

// --- The hook --------------------------------------------------------------------------------------------------

/** Button text for the run in progress: this button's own step, or a hint that another run holds the wallet. */
export function busyLabel(active: ActiveTx | null, owner: string): string | null {
  if (!active) return null;
  if (active.owner !== owner) return 'Another transaction is in progress…';
  const step = active.steps[active.index];
  switch (active.phase) {
    case 'preparing':
      return active.attempt > 0 ? `${step.label} — ran out of gas, retrying…` : `${step.label} — preparing…`;
    case 'switching':
      return `Switching to ${networkLabel(step.chainId)}…`;
    case 'signing':
      return `${step.label} — confirm in wallet`;
    case 'confirming':
      return `${step.label} — waiting for confirmation`;
  }
}

/**
 * Runs a sequence of steps (switching chains as needed) with toasts and a data refresh. Only one run can be in
 * progress app-wide: a second click while one runs is ignored, and every action button shows it as busy.
 */
export function useTx() {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { showToast } = useUi();
  const { active, begin, phase, submitted, finished, end } = useTxState();
  const owner = useId();

  const run = useCallback(
    async (title: string, steps: TxStep[], options: RunOptions = {}): Promise<TxResult> => {
      const controller = begin(owner, title, steps);
      if (!controller) return { ok: false };
      const driver: TxDriver = {
        wallet: () => {
          const { address, chainId } = getAccount(config);
          return { address, chainId };
        },
        switchChain: async (chainId) => {
          // Mezo Passport's Bitcoin wallets sign through a smart account that only exists on Mezo.
          if (getAccount(config).connector?.type === 'orangekit') {
            throw new Error(`Bitcoin wallets can only sign on ${HUB.label}; connect an EVM wallet to act on ${networkLabel(chainId)}`);
          }
          await switchChain(config, { chainId });
          // Some connectors report the new chain a moment after the switch resolves.
          for (let i = 0; i < 30 && getAccount(config).chainId !== chainId; i++) await new Promise((r) => setTimeout(r, 100));
        },
        client: (chainId) => getPublicClient(config, { chainId }) as TxClient | undefined,
        write: (request, chainId, gas) => writeContract(config, { ...request, chainId, gas } as Parameters<typeof writeContract>[1]),
        explain: explainTxError,
      };
      try {
        const outcome = await runSteps(driver, steps, {
          signal: controller.signal,
          onPhase: (index, next, attempt) => phase(owner, index, next, attempt),
          onSubmitted: (index, hash) => {
            submitted(owner, index, hash);
            options.onSubmitted?.(steps[index], hash);
          },
          onStepDone: (index, status) => finished(owner, index, status),
        });
        if (outcome.ok) {
          const last = [...outcome.steps].reverse().find((s) => s.status === 'done');
          const href = last ? stepTxUrl(last) : null;
          showToast(`${title} confirmed`, 'ok', href ? { link: { href, label: 'View transaction' } } : {});
          return { ok: true, receipts: outcome.receipts };
        }
        const landed = outcome.steps.some((s) => s.status === 'done');
        const pendingHref = outcome.pending ? stepTxUrl(outcome.pending) : null;
        showToast(outcome.error, 'error', {
          steps: landed || outcome.pending ? outcome.steps : undefined,
          link: pendingHref ? { href: pendingHref, label: 'Follow it in the explorer' } : undefined,
          // A declined signature is the user's own choice: no need to keep it on screen.
          sticky: !outcome.rejected,
        });
        return outcome.pending ? { ok: false, pending: outcome.pending } : { ok: false };
      } finally {
        end(owner);
        void queryClient.invalidateQueries();
      }
    },
    [begin, config, end, finished, owner, phase, queryClient, showToast, submitted],
  );

  return { run, busy: busyLabel(active, owner) };
}
