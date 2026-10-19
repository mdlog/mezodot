import { useEffect, useState } from 'react';
import { Check, CircleDashed, ExternalLink, Minus, TriangleAlert, X } from 'lucide-react';
import type { StepReport, StepStatus } from '../chain/runner';
import { stepTxUrl } from '../chain/tx';
import { useTxState, type ActiveTx } from '../state/TxContext';
import { useUi } from '../state/UiContext';
import { Spinner } from './ui';

/** Seconds a receipt is awaited before "Stop waiting" is offered (Mezo blocks take ~5 s, spokes up to ~12 s). */
export const STOP_WAITING_AFTER_SEC = 45;

const STATUS_TEXT: Record<StepStatus, string> = {
  done: 'confirmed',
  skipped: 'not needed',
  failed: 'reverted',
  pending: 'still pending',
  'not-sent': 'not sent',
};

function StepIcon({ status }: { status: StepStatus | 'current' | 'upcoming' }) {
  if (status === 'done') return <Check size={12} aria-hidden="true" />;
  if (status === 'failed') return <X size={12} aria-hidden="true" />;
  if (status === 'current' || status === 'pending') return <Spinner />;
  if (status === 'skipped') return <Minus size={12} aria-hidden="true" />;
  return <CircleDashed size={12} aria-hidden="true" />;
}

function TxHashLink({ step }: { step: Pick<StepReport, 'chainId' | 'hash'> }) {
  const href = stepTxUrl(step);
  if (!href || !step.hash) return null;
  return (
    <a className="toast-link" href={href} target="_blank" rel="noreferrer">
      {step.hash.slice(0, 8)}… <ExternalLink size={10} />
    </a>
  );
}

/** What happened to each step of an action, e.g. "Approve WETH · confirmed" then "Lock WETH · reverted". */
function StepList({ steps }: { steps: StepReport[] }) {
  return (
    <ol className="toast-steps">
      {steps.map((s, i) => (
        <li key={i} className={`toast-step toast-step--${s.status}`}>
          <StepIcon status={s.status} />
          <span>
            {s.label} · {STATUS_TEXT[s.status]}
          </span>
          <TxHashLink step={s} />
        </li>
      ))}
    </ol>
  );
}

export function ToastView() {
  const { toast, dismissToast } = useUi();
  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <span>{toast.tone === 'error' ? <TriangleAlert size={14} /> : <Check size={14} />}</span>
      <div className="toast-body">
        <p>{toast.message}</p>
        {toast.steps && <StepList steps={toast.steps} />}
        {toast.link && (
          <a className="toast-link" href={toast.link.href} target="_blank" rel="noreferrer">
            {toast.link.label} <ExternalLink size={10} />
          </a>
        )}
      </div>
      <button onClick={dismissToast} aria-label="Dismiss notification">
        <X size={14} />
      </button>
    </div>
  );
}

const phaseText = (tx: ActiveTx): string => {
  switch (tx.phase) {
    case 'preparing':
      return tx.attempt > 0 ? 'ran out of gas, sending again with a higher limit' : 'preparing';
    case 'switching':
      return 'switching network in your wallet';
    case 'signing':
      return 'confirm in your wallet';
    case 'confirming':
      return 'waiting for confirmation';
  }
};

/** The run in progress: every step with its state and hash, and a way to stop waiting on a stuck receipt. */
export function TxProgress() {
  const { active, stopWaiting } = useTxState();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active) return null;
  const waited = Math.max(0, Math.round((now - active.phaseSince) / 1000));
  const stuck = active.phase === 'confirming' && waited >= STOP_WAITING_AFTER_SEC;
  return (
    <div className="toast toast--pending" role="status" aria-live="polite">
      <span>
        <Spinner />
      </span>
      <div className="toast-body">
        <p>
          <b>{active.title}</b> · step {active.index + 1} of {active.steps.length}: {phaseText(active)}
          {active.phase === 'confirming' && waited >= 10 ? ` (${waited} s)` : ''}
        </p>
        {active.steps.length > 1 && (
          <ol className="toast-steps">
            {active.steps.map((s, i) => {
              const status = active.finished[i] ?? (i === active.index ? 'current' : 'upcoming');
              return (
                <li key={i} className={`toast-step toast-step--${status}`}>
                  <StepIcon status={status} />
                  <span>{s.label}</span>
                  <TxHashLink step={{ chainId: s.chainId, hash: active.hashes[i] ?? undefined }} />
                </li>
              );
            })}
          </ol>
        )}
        {active.steps.length === 1 && active.hashes[0] && <TxHashLink step={{ chainId: active.steps[0].chainId, hash: active.hashes[0] }} />}
        {stuck && (
          <p className="toast-hint">
            Taking longer than usual. The transaction may still land; you can stop waiting and follow it in the explorer.{' '}
            <button className="toast-action" onClick={stopWaiting}>
              Stop waiting
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
