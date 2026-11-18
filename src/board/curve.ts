/**
 * Geometry for the curved connections drawn on a board.
 *
 * Deliberately free of Obsidian and DOM: the label placement (project a click
 * onto a curve) and the path text are the parts most worth testing, and they
 * must be computable before the board has been laid out — during load the
 * layer is still hidden, so nothing here may depend on measurement.
 */

export interface Point {
  x: number;
  y: number;
}

/** A cubic Bezier in board units. */
export interface Curve {
  p1: Point;
  c1: Point;
  c2: Point;
  p2: Point;
}

/** How close to either end an edge label may sit. Keeps a chip from being
 *  half buried under the card the line starts from. */
export const LABEL_T_MIN = 0.04;
export const LABEL_T_MAX = 0.96;

export function curvePath(curve: Curve): string {
  const { p1, c1, c2, p2 } = curve;
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
}

export function curvePoint(curve: Curve, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;

  return {
    x: a * curve.p1.x + b * curve.c1.x + c * curve.c2.x + d * curve.p2.x,
    y: a * curve.p1.y + b * curve.c1.y + c * curve.c2.y + d * curve.p2.y,
  };
}

/**
 * Parameter of the point on `curve` closest to `target` — this is how a
 * double-click at a spot on a line becomes a label position. Coarse sampling
 * followed by bisection rounds: an exact projection buys nothing, it only has
 * to land where the pointer did to within a pixel.
 */
export function nearestCurveT(curve: Curve, target: Point): number {
  const steps = 64;
  let best = 0.5;
  let bestDist = Infinity;

  const consider = (t: number): void => {
    const point = curvePoint(curve, t);
    const dist = (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  };

  for (let i = 0; i <= steps; i++) consider(i / steps);

  // Refine around the winning sample; the bracket halves every round.
  let span = (1 / steps) * 2;
  for (let round = 0; round < 10; round++) {
    consider(Math.max(0, best - span));
    consider(Math.min(1, best + span));
    span /= 2;
  }

  return best;
}

/** Keeps a stored position usable: hand-edited files may hold anything. */
export function clampLabelT(t: number): number {
  if (!Number.isFinite(t)) return 0.5;
  return Math.min(LABEL_T_MAX, Math.max(LABEL_T_MIN, t));
}
