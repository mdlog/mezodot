import { describe, expect, it } from 'vitest';
import { easeOutCubic, tweenAt } from './motion';

describe('landing motion maths', () => {
  it('eases out and clamps outside 0..1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(3)).toBe(1);
  });

  it('tweens from the value on screen to the new target', () => {
    expect(tweenAt(0, 120, 0, 1000)).toBe(0);
    expect(tweenAt(0, 120, 1000, 1000)).toBe(120);
    expect(tweenAt(0, 120, 500, 1000)).toBeCloseTo(105, 9);
    // A refetch that moves TVL from 113 to 115 glides from 113, it does not restart at zero.
    expect(tweenAt(113, 115, 500, 1000)).toBeCloseTo(114.75, 9);
    expect(tweenAt(5, 9, 10, 0)).toBe(9);
  });
});
