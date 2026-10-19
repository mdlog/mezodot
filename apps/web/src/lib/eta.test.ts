import { describe, expect, it } from 'vitest';
import { finalityEta, formatWait } from './eta';

const MIN = 60_000;

describe('waiting for Wormhole guardians', () => {
  it('counts down from the source chain finality and flags an overdue message', () => {
    const created = 1_000_000;
    expect(finalityEta(created, 15 * 60, created + 3 * MIN)).toEqual({ remainingSec: 12 * 60, overdue: false });
    expect(finalityEta(created, 15 * 60, created + 15 * MIN)).toEqual({ remainingSec: 0, overdue: false });
    // Up to 50% over the typical time is still normal variance; beyond that it is reported as slow.
    expect(finalityEta(created, 15 * 60, created + 22 * MIN).overdue).toBe(false);
    expect(finalityEta(created, 15 * 60, created + 23 * MIN)).toEqual({ remainingSec: 0, overdue: true });
  });

  it('formats waits the way the UI shows them', () => {
    expect(formatWait(12 * 60)).toBe('≈ 12 min');
    expect(formatWait(90)).toBe('≈ 2 min');
    expect(formatWait(40)).toBe('< 1 min');
    expect(formatWait(0)).toBe('any moment now');
  });
});
