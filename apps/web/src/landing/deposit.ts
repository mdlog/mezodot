/**
 * The deposit the landing hero plays on request: a lock on a spoke, its Wormhole message travelling to the guardians,
 * a quorum signing it, the hub crediting the collateral, and a borrow against it. Durations are the animation's own;
 * a real deposit waits for spoke finality (15 to 20 minutes) before the guardians sign.
 */
export type DepositStep = { id: 'lock' | 'travel' | 'sign' | 'credit' | 'borrow'; ms: number };

export const DEPOSIT_STEPS: readonly DepositStep[] = [
  { id: 'lock', ms: 1_500 },
  { id: 'travel', ms: 1_400 },
  { id: 'sign', ms: 2_200 },
  { id: 'credit', ms: 1_400 },
  { id: 'borrow', ms: 2_000 },
];

export const DEPOSIT_MS = DEPOSIT_STEPS.reduce((sum, s) => sum + s.ms, 0);

/** Wormhole's guardian set, and the signatures a message needs. */
export const GUARDIANS = 19;
export const QUORUM = 13;

const SIGN = DEPOSIT_STEPS.findIndex((s) => s.id === 'sign');

/** Where a played deposit is `elapsed` ms in: its step and how far into it (0 to 1); null once it has finished. */
export function depositAt(elapsed: number): { step: number; progress: number } | null {
  let start = 0;
  const at = Math.max(0, elapsed);
  for (let step = 0; step < DEPOSIT_STEPS.length; step++) {
    const { ms } = DEPOSIT_STEPS[step];
    if (at < start + ms) return { step, progress: (at - start) / ms };
    start += ms;
  }
  return null;
}

/** Guardians that have signed by `progress` into `step`: none before signing starts, the quorum from its end on. */
export function guardiansSigned(step: number, progress: number): number {
  if (step < SIGN) return 0;
  if (step > SIGN) return QUORUM;
  return Math.min(QUORUM, Math.ceil(progress * QUORUM));
}
