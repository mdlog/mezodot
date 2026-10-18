import { describe, expect, it } from 'vitest';
import { pointAlong, polylineLength, roundedPath } from './polyline';

describe('polyline helpers (topology edges)', () => {
  const L: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 50],
  ];

  it('measures and walks an orthogonal polyline', () => {
    expect(polylineLength(L)).toBe(150);
    expect(pointAlong(L, 0)).toEqual([0, 0]);
    expect(pointAlong(L, 0.5)).toEqual([75, 0]);
    expect(pointAlong(L, 1)).toEqual([100, 50]);
    expect(pointAlong([[5, 5]], 0.5)).toEqual([5, 5]);
  });

  it('rounds each corner without overshooting short segments', () => {
    expect(roundedPath(L, 8)).toBe('M 0 0 L 92 0 Q 100 0 100 8 L 100 50');
    // A 10-unit segment can take at most a 5-unit radius on each end.
    expect(
      roundedPath(
        [
          [0, 0],
          [10, 0],
          [10, 40],
        ],
        8,
      ),
    ).toBe('M 0 0 L 5 0 Q 10 0 10 5 L 10 40');
    expect(
      roundedPath(
        [
          [0, 0],
          [30, 0],
        ],
        8,
      ),
    ).toBe('M 0 0 L 30 0');
  });
});
