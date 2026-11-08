export type Point = { x: number; y: number };

// Include edges, but reject a collapsed triangle (for example a vertical scrub).
export function pointInTriangle(point: Point, a: Point, b: Point, c: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a, b, c) === 0) return false;
  const sides = [cross(a, b, point), cross(b, c, point), cross(c, a, point)];
  return sides.every(side => side >= 0) || sides.every(side => side <= 0);
}
