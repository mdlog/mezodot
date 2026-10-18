import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Hash } from 'viem';
import type { StepPhase, TxStep } from '../chain/runner';

/** The one transaction run in progress, app-wide: wallets sign one request at a time and share one network. */
export type ActiveTx = {
  owner: string;
  title: string;
  steps: { label: string; chainId: number }[];
  index: number;
  phase: StepPhase;
  /** 1 while a step is sent again after running out of gas. */
  attempt: number;
  /** Hash per step once the wallet has returned it. */
  hashes: (Hash | null)[];
  /** Steps finished so far: mined, or skipped because they were not needed. */
  finished: ('done' | 'skipped' | null)[];
  /** When the current phase began (ms), for "still waiting" hints. */
  phaseSince: number;
};

type TxValue = {
  active: ActiveTx | null;
  /** Claims the transaction slot (checked synchronously, so a double click cannot start a second run). */
  begin(owner: string, title: string, steps: readonly TxStep[]): AbortController | null;
  phase(owner: string, index: number, phase: StepPhase, attempt: number): void;
  submitted(owner: string, index: number, hash: Hash): void;
  finished(owner: string, index: number, status: 'done' | 'skipped'): void;
  end(owner: string): void;
  /** Stops waiting for the receipt of the active run's current step. */
  stopWaiting(): void;
};

const TxContext = createContext<TxValue | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveTx | null>(null);
  const slot = useRef<{ owner: string; controller: AbortController } | null>(null);

  const patch = useCallback((owner: string, change: (tx: ActiveTx) => ActiveTx) => {
    if (slot.current?.owner !== owner) return;
    setActive((tx) => (tx && tx.owner === owner ? change(tx) : tx));
  }, []);

  const begin = useCallback<TxValue['begin']>((owner, title, steps) => {
    if (slot.current) return null;
    const controller = new AbortController();
    slot.current = { owner, controller };
    setActive({
      owner,
      title,
      steps: steps.map((s) => ({ label: s.label, chainId: s.chainId })),
      index: 0,
      phase: 'preparing',
      attempt: 0,
      hashes: steps.map(() => null),
      finished: steps.map(() => null),
      phaseSince: Date.now(),
    });
    return controller;
  }, []);

  const phase = useCallback<TxValue['phase']>(
    (owner, index, next, attempt) => patch(owner, (tx) => ({ ...tx, index, phase: next, attempt, phaseSince: Date.now() })),
    [patch],
  );
  const submitted = useCallback<TxValue['submitted']>(
    (owner, index, hash) => patch(owner, (tx) => ({ ...tx, hashes: tx.hashes.map((h, i) => (i === index ? hash : h)) })),
    [patch],
  );
  const finished = useCallback<TxValue['finished']>(
    (owner, index, status) => patch(owner, (tx) => ({ ...tx, finished: tx.finished.map((f, i) => (i === index ? status : f)) })),
    [patch],
  );
  const end = useCallback<TxValue['end']>((owner) => {
    if (slot.current?.owner !== owner) return;
    slot.current = null;
    setActive(null);
  }, []);
  const stopWaiting = useCallback(() => slot.current?.controller.abort(), []);

  const value = useMemo<TxValue>(
    () => ({ active, begin, phase, submitted, finished, end, stopWaiting }),
    [active, begin, phase, submitted, finished, end, stopWaiting],
  );
  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}

export function useTxState(): TxValue {
  const ctx = useContext(TxContext);
  if (!ctx) throw new Error('useTxState must be used inside <TxProvider>');
  return ctx;
}
