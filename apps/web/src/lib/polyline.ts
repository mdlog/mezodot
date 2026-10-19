export type Point = [number, number];

const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export const polylineLength = (points: Point[]): number => points.slice(1).reduce((sum, p, i) => sum + dist(points[i], p), 0);

/** Point `t` (0..1) of the way along a polyline, by length. */
export function pointAlong(points: Point[], t: number): Point {
  let left = polylineLength(points) * Math.min(1, Math.max(0, t));
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (left <= seg && seg > 0) {
      const k = left / seg;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * k, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * k];
    }
    left -= seg;
  }
  return points[points.length - 1];
}

/** SVG path through `points` with each corner rounded by up to `radius` (never more than half a segment). */
export function roundedPath(points: Point[], radius: number): string {
  const fmt = (p: Point) => `${+p[0].toFixed(2)} ${+p[1].toFixed(2)}`;
  let d = `M ${fmt(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [prev, at, next] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, dist(prev, at) / 2, dist(at, next) / 2);
    const toward = (from: Point, to: Point, len: number): Point => {
      const k = len / dist(from, to);
      return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
    };
    d += ` L ${fmt(toward(at, prev, r))} Q ${fmt(at)} ${fmt(toward(at, next, r))}`;
  }
  return `${d} L ${fmt(points[points.length - 1])}`;
}
