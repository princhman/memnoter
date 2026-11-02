import type { Box } from "@/lib/box";
export type Point = { x: number; y: number };
// `group` joins masks into one card: the id of the mask whose card it is.
export type Mask = { id: string; group?: string } & (
  | { shape: "rectangle"; x: number; y: number; width: number; height: number }
  | { shape: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { shape: "freehand"; points: Point[] }
);
export type OcclusionFace = {
  version: 1; fileId: string; imageId: string; targetMaskId: string;
  // Every mask the card asks; missing in faces stored before joining.
  targetMaskIds?: string[];
  revealed: boolean; masks: Mask[];
};

// The masks asked together, one card each: a joined group, or a single mask.
// The card is the owner's, so its schedule survives joining; an owner that
// was deleted passes the card to the group's first mask.
export function maskCards(masks: Mask[]): { owner: Mask; members: Mask[] }[] {
  const groups = new Map<string, Mask[]>();
  for (const mask of masks) {
    const key = typeof mask.group === "string" && mask.group ? mask.group : mask.id;
    groups.set(key, [...(groups.get(key) ?? []), mask]);
  }
  return [...groups].map(([key, members]) => ({ owner: members.find(m => m.id === key) ?? members[0], members }));
}

// The ids of the masks a face asks.
export function targetsOf(face: OcclusionFace): string[] {
  return Array.isArray(face.targetMaskIds) ? face.targetMaskIds : [face.targetMaskId];
}
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
// The box a mask fills, for moving and resizing it like a crop area.
export function maskBounds(mask: Mask): Box {
  if (mask.shape === "rectangle") return { x: mask.x, y: mask.y, width: mask.width, height: mask.height };
  if (mask.shape === "ellipse") return { x: mask.cx - mask.rx, y: mask.cy - mask.ry, width: 2 * mask.rx, height: 2 * mask.ry };
  const xs = mask.points.map((p) => p.x), ys = mask.points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// The mask fitted to a new box; a freehand path is stretched to fill it.
export function withBounds(mask: Mask, box: Box): Mask {
  if (mask.shape === "rectangle") return { ...mask, ...box };
  if (mask.shape === "ellipse") {
    return { ...mask, cx: box.x + box.width / 2, cy: box.y + box.height / 2, rx: box.width / 2, ry: box.height / 2 };
  }
  const from = maskBounds(mask);
  return {
    ...mask,
    points: mask.points.map((p) => ({
      x: clamp(box.x + ((p.x - from.x) / from.width) * box.width),
      y: clamp(box.y + ((p.y - from.y) / from.height) * box.height),
    })),
  };
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
  const masks = validMasks(attrs.masks);
  const ids = new Map(masks.map(m => [m.id, newId()]));
  // Joined masks stay joined under their new ids.
  return { ...attrs, imageId: newId(), masks: masks.map(m => ({ ...m, id: ids.get(m.id)!, ...(m.group ? { group: ids.get(m.group) ?? ids.get(m.id)! } : {}) })) };
}
