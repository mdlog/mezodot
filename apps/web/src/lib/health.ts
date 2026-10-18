import type { HealthTone } from '@mezodot/sdk';

/**
 * One scale for every health factor visual: 0 is the liquidation line (1.0×), 1 is 3.0× and safer (and "no
 * debt"). It is logarithmic, so the stretch just above liquidation, where a position needs attention, gets
 * the most room: 1.2× sits at 17%, 2.0× at 63%.
 */
export const HEALTH_SCALE_MAX = 3;

export const healthPosition = (hf: number): number => {
  if (!(hf > 1)) return 0;
  if (!Number.isFinite(hf) || hf >= HEALTH_SCALE_MAX) return 1;
  return Math.log(hf) / Math.log(HEALTH_SCALE_MAX);
};

/** Bands of the scale, matching healthStatus: at risk below 1.2×, monitor below 1.5×, healthy from 1.5×. */
export const HEALTH_BANDS: { from: number; to: number; tone: HealthTone }[] = [
  { from: 1, to: 1.2, tone: 'danger' },
  { from: 1.2, to: 1.5, tone: 'warn' },
  { from: 1.5, to: HEALTH_SCALE_MAX, tone: 'ok' },
];

/**
 * The same bands in LTV terms, for a position liquidated at `liqLtv` (its health factor is liqLtv / LTV), from
 * 0% LTV up to the liquidation line. This keeps the LTV meter's colours in step with the health status.
 */
export const ltvBands = (liqLtv: number): { from: number; to: number; tone: HealthTone }[] =>
  [...HEALTH_BANDS].reverse().map((b, i) => ({ from: i === 0 ? 0 : liqLtv / b.to, to: liqLtv / b.from, tone: b.tone }));

/** Point at `position` (0..1) on a semicircle of radius `r`, from the left end over the top; y grows downwards (SVG). */
export const gaugePoint = (position: number, r: number): [number, number] => {
  const angle = Math.PI * (1 - position);
  return [r * Math.cos(angle), -r * Math.sin(angle)];
};
