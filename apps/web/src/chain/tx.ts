import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useConfig } from 'wagmi';
import { switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import type { Hash, TransactionReceipt } from 'viem';
import { explainError } from '../lib/errors';
import { useUi } from '../state/UiContext';

export { explainError };

/** One wallet transaction. `request` is built lazily so price updates are fetched just in time. */
export type TxStep = {
  label: string;
  chainId: number;
  // Loosely typed on purpose: every step is a fully-typed `writeContract` request built by actions.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: () => Promise<any | null>;
};

export type TxResult = { ok: true; receipts: TransactionReceipt[] } | { ok: false };

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
