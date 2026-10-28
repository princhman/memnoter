export type Point = { x: number; y: number };
export type Mask = { id: string } & (
  | { shape: "rectangle"; x: number; y: number; width: number; height: number }
  | { shape: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { shape: "freehand"; points: Point[] }
);
export type OcclusionFace = {
  version: 1; fileId: string; imageId: string; targetMaskId: string;
  revealed: boolean; masks: Mask[];
};
export const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function normalizedPoint(x: number, y: number, bounds: { left: number; top: number; width: number; height: number }): Point {
  return { x: clamp((x - bounds.left) / bounds.width), y: clamp((y - bounds.top) / bounds.height) };
}
export function drawMask(shape: Mask["shape"], points: Point[], id: string): Mask {
  const a = points[0], b = points[points.length - 1];
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x), height = Math.abs(a.y - b.y);
  if (shape === "freehand") return { id, shape, points: points.map(p => ({ x: clamp(p.x), y: clamp(p.y) })) };
  return shape === "rectangle" ? { id, shape, x, y, width, height } : { id, shape, cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2 };
}
export function validMasks(value: unknown): Mask[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  return value.filter((m): m is Mask => {
    if (!m || typeof m.id !== "string" || !m.id || ids.has(m.id)) return false;
    let valid = false;
    if (m.shape === "rectangle") valid = [m.x,m.y,m.width,m.height].every(unit) && m.width > 0 && m.height > 0 && m.x + m.width <= 1.000001 && m.y + m.height <= 1.000001;
    if (m.shape === "ellipse") valid = [m.cx,m.cy,m.rx,m.ry].every(unit) && m.rx > 0 && m.ry > 0 && m.cx >= m.rx && m.cy >= m.ry && m.cx + m.rx <= 1.000001 && m.cy + m.ry <= 1.000001;
    if (m.shape === "freehand") valid = Array.isArray(m.points) && m.points.length >= 3 && m.points.length <= 4096 && m.points.every((p: Point) => p && unit(p.x) && unit(p.y)) && Math.abs(m.points.reduce((sum: number, p: Point, i: number) => { const q = m.points[(i + 1) % m.points.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) > 0.00001;
    if (valid) ids.add(m.id);
    return valid;
  });
}
export function renewImageIdentity(attrs: Record<string, unknown>, newId: () => string) {
  return { ...attrs, imageId: newId(), masks: validMasks(attrs.masks).map(m => ({ ...m, id: newId() })) };
}
