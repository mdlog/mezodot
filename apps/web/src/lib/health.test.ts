import { describe, expect, it } from 'vitest';
import { healthStatus } from '@mezodot/sdk';
import { HEALTH_BANDS, gaugePoint, healthPosition, ltvBands } from './health';

describe('health factor scale', () => {
  it('starts at the liquidation line and ends at 3.0×', () => {
    // The old bar filled hf / 3: a position at the liquidation line still looked a third full.
    expect(healthPosition(1)).toBe(0);
    expect(healthPosition(0.85)).toBe(0);
    expect(healthPosition(3)).toBe(1);
    expect(healthPosition(7.5)).toBe(1);
    expect(healthPosition(Infinity)).toBe(1);
  });

  it('gives the range near liquidation most of the room', () => {
    expect(healthPosition(1.07)).toBeCloseTo(0.0616, 3);
    expect(healthPosition(1.2)).toBeGreaterThan(0.15);
    expect(healthPosition(2)).toBeCloseTo(0.631, 3);
  });

  it('colours each band like the status label', () => {
    expect(HEALTH_BANDS[0].from).toBe(1);
    expect(HEALTH_BANDS.at(-1)!.to).toBe(3);
    HEALTH_BANDS.forEach((band, i) => {
      if (i > 0) expect(band.from).toBe(HEALTH_BANDS[i - 1].to);
      expect(healthStatus((band.from + band.to) / 2).tone).toBe(band.tone);
      expect(healthStatus(band.from).tone).toBe(band.tone);
    });
  });

  it('projects the bands onto LTV for the LTV meter (HF = liquidation LTV / LTV)', () => {
    const bands = ltvBands(0.8);
    expect(bands.map((b) => b.tone)).toEqual(['ok', 'warn', 'danger']);
    expect(bands[0].from).toBe(0);
    expect(bands[0].to).toBeCloseTo(0.8 / 1.5, 9);
    expect(bands[1].to).toBeCloseTo(0.8 / 1.2, 9);
    expect(bands[2].to).toBe(0.8);
    // Borrowing up to the 75% limit leaves HF 1.07: the at-risk band, as the status label says.
    const toneAt = (ltv: number) => bands.find((b) => ltv >= b.from && ltv < b.to)?.tone;
    expect(toneAt(0.747)).toBe('danger');
    expect(toneAt(0.747)).toBe(healthStatus(0.8 / 0.747).tone);
    expect(toneAt(0.6)).toBe(healthStatus(0.8 / 0.6).tone);
    expect(toneAt(0.3)).toBe(healthStatus(0.8 / 0.3).tone);
  });

  it('places the gauge from left (liquidation) over the top to right', () => {
    const [x0, y0] = gaugePoint(0, 50);
    const [xm, ym] = gaugePoint(0.5, 50);
    const [x1, y1] = gaugePoint(1, 50);
    expect(x0).toBeCloseTo(-50, 9);
    expect(y0).toBeCloseTo(0, 9);
    expect(xm).toBeCloseTo(0, 9);
    expect(ym).toBeCloseTo(-50, 9);
    expect(x1).toBeCloseTo(50, 9);
    expect(y1).toBeCloseTo(0, 9);
  });
});
