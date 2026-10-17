import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useConfig } from 'wagmi';
import { switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Hash, type TransactionReceipt } from 'viem';
import { useUi } from '../state/UiContext';

/** One wallet transaction. `request` is built lazily so price updates are fetched just in time. */
export type TxStep = {
  label: string;
  chainId: number;
  // Loosely typed on purpose: every step is a fully-typed `writeContract` request built by actions.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: () => Promise<any | null>;
};

export type TxResult = { ok: true; receipts: TransactionReceipt[] } | { ok: false };

const FRIENDLY: Record<string, string> = {
  InsufficientCollateral: 'This would exceed your borrow limit',
  InsufficientBalance: 'Not enough collateral posted',
  InsufficientCash: 'Not enough liquidity in the pool',
  PositionHealthy: 'Position is healthy — nothing to liquidate',
  SlippageExceeded: 'Price moved; try again',
  NotOperator: 'Approve LeverageManager as operator first',
  CapExceeded: 'Collateral cap reached',
  BorrowCapExceeded: 'Market borrow cap reached',
  NothingToRepay: 'No debt to repay',
  StalePrice: 'Oracle price is stale — refresh and retry',
  PriceUncertain: 'Oracle confidence too low right now',
  InvalidLeverage: 'Choose a leverage above 1×',
  TokenNotAllowed: 'Token not accepted on this spoke',
  WrongFee: 'Wormhole fee changed; retry',
  AlreadyConsumed: 'Message already delivered',
  EnforcedPause: 'Protocol is paused for new positions',
};

/** Turns wallet / revert errors into one readable sentence. */
export function explainError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'Transaction rejected in wallet';
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name) return FRIENDLY[name] ?? name;
    return err.shortMessage;
  }
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

/** Runs a sequence of steps (switching chains as needed), with toasts and data refresh. */
export function useTx() {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { chainId } = useAccount();
  const { showToast } = useUi();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (title: string, steps: TxStep[]): Promise<TxResult> => {
      const receipts: TransactionReceipt[] = [];
      try {
        let current = chainId;
        for (const step of steps) {
          const request = await step.request();
          if (!request) continue; // step not needed (e.g. allowance already sufficient)
          if (current !== step.chainId) {
            setBusy(`Switching network…`);
            await switchChain(config, { chainId: step.chainId });
            current = step.chainId;
          }
          setBusy(`${step.label} — confirm in wallet`);
          const hash: Hash = await writeContract(config, { ...request, chainId: step.chainId });
          setBusy(`${step.label} — waiting for confirmation`);
          const receipt = await waitForTransactionReceipt(config, { hash, chainId: step.chainId });
          if (receipt.status !== 'success') throw new Error(`${step.label} reverted`);
          receipts.push(receipt);
        }
        showToast(`${title} confirmed`);
        return { ok: true, receipts };
      } catch (err) {
        showToast(explainError(err), 'error');
        return { ok: false };
      } finally {
        setBusy(null);
        void queryClient.invalidateQueries();
      }
    },
    [chainId, config, queryClient, showToast],
  );

  return { run, busy };
}
