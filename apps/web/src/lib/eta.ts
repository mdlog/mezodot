/**
 * Wormhole guardians sign a message only once its source block is final (consistency level "finalized"),
 * so the wait is set by the source chain: see NetworkInfo.finalitySec.
 */

/** A message is reported as slow only after this multiple of the typical finality time. */
const OVERDUE_FACTOR = 1.5;

/** Seconds left until the guardians typically sign, and whether the message is unusually late. */
export function finalityEta(createdAtMs: number, finalitySec: number, nowMs: number): { remainingSec: number; overdue: boolean } {
  const elapsedSec = Math.max(0, (nowMs - createdAtMs) / 1000);
  return { remainingSec: Math.max(0, Math.round(finalitySec - elapsedSec)), overdue: elapsedSec > finalitySec * OVERDUE_FACTOR };
}

export function formatWait(sec: number): string {
  if (sec <= 0) return 'any moment now';
  if (sec < 60) return '< 1 min';
  return `≈ ${Math.round(sec / 60)} min`;
}
