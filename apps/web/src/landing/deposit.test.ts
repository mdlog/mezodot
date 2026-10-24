import { describe, expect, it } from 'vitest';
import { DEPOSIT_MS, DEPOSIT_STEPS, depositAt, guardiansSigned } from './deposit';

const startOf = (id: (typeof DEPOSIT_STEPS)[number]['id']) => {
  let at = 0;
  for (const s of DEPOSIT_STEPS) {
    if (s.id === id) return at;
    at += s.ms;
  }
  throw new Error(id);
};

describe('the played deposit', () => {
  it('runs lock, travel, sign, credit and borrow in order', () => {
    expect(DEPOSIT_STEPS.map((s) => s.id)).toEqual(['lock', 'travel', 'sign', 'credit', 'borrow']);
    expect(DEPOSIT_MS).toBe(DEPOSIT_STEPS.reduce((sum, s) => sum + s.ms, 0));
  });

  it('places a moment in its step, with how far into that step it is', () => {
    expect(depositAt(0)).toEqual({ step: 0, progress: 0 });
    const travel = DEPOSIT_STEPS[1];
    expect(depositAt(startOf('travel'))).toEqual({ step: 1, progress: 0 });
    expect(depositAt(startOf('travel') + travel.ms / 2)).toEqual({ step: 1, progress: 0.5 });
    expect(depositAt(-50)).toEqual({ step: 0, progress: 0 });
  });

  it('is over once every step has run', () => {
    expect(depositAt(DEPOSIT_MS)).toBeNull();
    expect(depositAt(DEPOSIT_MS - 1)?.step).toBe(4);
  });

  it('lights guardians up to the quorum of 13 while the message waits, and keeps them lit after', () => {
    const sign = DEPOSIT_STEPS.findIndex((s) => s.id === 'sign');
    expect(guardiansSigned(sign - 1, 1)).toBe(0);
    expect(guardiansSigned(sign, 0)).toBe(0);
    expect(guardiansSigned(sign, 0.5)).toBe(7);
    expect(guardiansSigned(sign, 1)).toBe(13);
    expect(guardiansSigned(sign + 1, 0)).toBe(13);
  });
});
