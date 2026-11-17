// Native descriptors approximate rendering only. Indexed PKStrokes in the
// immutable nativeData basis retain masks, texture and editable native fidelity.
export type InkPoint = { x: number; y: number; pressure: number };
export type InkStroke = { tool: "pen" | "marker"; color: string; width: number; points: InkPoint[] };
type MaskElement = { command: "move" | "line" | "quadratic" | "cubic" | "close"; coordinates: number[] };
export type NativeStroke = {
  kind: "native"; nativeIndex: number; tool: string; color: string; width: number; alpha: number;
  transform: number[]; mask: MaskElement[] | null; maskUsesEvenOddFillRule: boolean;
  points: (InkPoint & { width: number; height: number; opacity: number; azimuth: number })[];
};
export type PortableStroke = InkStroke | NativeStroke;
export type PortableInk = { version: 1 | 2; strokes: PortableStroke[] };
export type InkDocument = { version: 1 | 2; nativeData: string; width: number; height: number; geometry?: string | null; portable: PortableInk };
const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const fail = (): never => { throw new Error("This drawing contains unsupported or legacy native ink. Edit it on an updated Apple device first; its source has not been changed."); };
export function parseInk(value: unknown): InkDocument {
  const v = record(value), ink = record(v.portable);
  if ((v.version !== 1 && v.version !== 2) || typeof v.nativeData !== "string" || v.nativeData.length > 89_478_488 || !finite(v.width, 1, 100_000) || !finite(v.height, 1, 1_000_000) || (ink.version !== 1 && ink.version !== 2) || !Array.isArray(ink.strokes) || ink.strokes.length > 20000) return fail();
  let count = 0, masks = 0;
  const strokes: PortableStroke[] = ink.strokes.map((value: unknown) => {
    const s = record(value);
    if (typeof s.color !== "string" || !/^#[0-9a-f]{6}$/i.test(s.color) || !finite(s.width, .1, 1000) || !Array.isArray(s.points) || !s.points.length) return fail();
    const points = s.points.map((value: unknown) => {
      const p = record(value);
      if (!finite(p.x, -1_000_000, 1_000_000) || !finite(p.y, -1_000_000, 1_000_000) || !finite(p.pressure, 0, 1) || ++count > 500000) return fail();
      return { x: p.x, y: p.y, pressure: p.pressure, width: p.width, height: p.height, opacity: p.opacity, azimuth: p.azimuth };
    });
    if (s.kind === "native") {
      if (ink.version !== 2 || !finite(s.nativeIndex, 0, 19999) || !Number.isInteger(s.nativeIndex) || !v.nativeData || typeof s.tool !== "string" || !s.tool.length || s.tool.length > 100 || !finite(s.alpha, 0, 1) || !Array.isArray(s.transform) || s.transform.length !== 6 || !s.transform.every(n => finite(n, -1_000_000, 1_000_000)) || typeof s.maskUsesEvenOddFillRule !== "boolean") return fail();
      const mask = s.mask == null ? null : (() => {
        if (!Array.isArray(s.mask)) return fail();
        return s.mask.map((value: unknown): MaskElement => {
          if (++masks > 500000) return fail();
          const e = record(value), c = e.command;
          const length = c === "move" || c === "line" ? 2 : c === "quadratic" ? 4 : c === "cubic" ? 6 : c === "close" ? 0 : -1;
          if ((c !== "move" && c !== "line" && c !== "quadratic" && c !== "cubic" && c !== "close") || !Array.isArray(e.coordinates) || e.coordinates.length !== length || !e.coordinates.every(n => finite(n, -1_000_000, 1_000_000))) return fail();
          return { command: c, coordinates: e.coordinates };
        });
      })();
      return { kind: "native", nativeIndex: s.nativeIndex, tool: s.tool, color: s.color, width: s.width, alpha: s.alpha,
        transform: s.transform, mask, maskUsesEvenOddFillRule: s.maskUsesEvenOddFillRule,
        points: points.map(p => {
          if (!finite(p.width, 0, 1000) || !finite(p.height, 0, 1000) || !finite(p.opacity, 0, 1) || !finite(p.azimuth, -1000, 1000)) return fail();
          return { ...p, width: p.width, height: p.height, opacity: p.opacity, azimuth: p.azimuth };
        }) };
    }
    if (s.kind !== undefined || s.nativeIndex !== undefined || s.transform !== undefined || s.mask !== undefined || s.alpha !== undefined || (s.tool !== "pen" && s.tool !== "marker") || s.width > 100) return fail();
    return { tool: s.tool, color: s.color, width: s.width, points: points.map(({ x, y, pressure }) => ({ x, y, pressure })) };
  });
  return { version: v.version, nativeData: v.nativeData, width: v.width, height: v.height, geometry: typeof v.geometry === "string" ? v.geometry : null, portable: { version: ink.version, strokes } };
}
function clipPath(stroke: NativeStroke): Path2D | null {
  if (!stroke.mask) return null;
  const path = new Path2D();
  for (const e of stroke.mask) {
    const a = e.coordinates;
    switch (e.command) {
      case "move": path.moveTo(a[0], a[1]); break;
      case "line": path.lineTo(a[0], a[1]); break;
      case "quadratic": path.quadraticCurveTo(a[0], a[1], a[2], a[3]); break;
      case "cubic": path.bezierCurveTo(a[0], a[1], a[2], a[3], a[4], a[5]); break;
      case "close": path.closePath(); break;
    }
  }
  return path;
}
export function hitInk(stroke: PortableStroke, x: number, y: number): boolean {
  let radius = 12;
  if ("kind" in stroke) {
    const [a,b,c,d,e,f] = stroke.transform, det = a*d-b*c;
    if (!det) return false;
    // PencilKit masks use drawing coordinates, before inverse stroke mapping.
    const path = clipPath(stroke);
    const ctx = document.createElement("canvas").getContext("2d");
    if (path && !ctx?.isPointInPath(path, x, y, stroke.maskUsesEvenOddFillRule ? "evenodd" : "nonzero")) return false;
    const px = x-e, py = y-f;
    x = (d*px-c*py)/det; y = (-b*px+a*py)/det;
    radius /= Math.max(.001, Math.hypot(a,b), Math.hypot(c,d));
    return stroke.points.some(p => {
      if (p.opacity * stroke.alpha === 0) return false;
      const dx = x-p.x, dy = y-p.y, cos = Math.cos(p.azimuth), sin = Math.sin(p.azimuth);
      return ((dx*cos+dy*sin)/(p.width/2+radius))**2 + ((-dx*sin+dy*cos)/(p.height/2+radius))**2 <= 1;
    });
  }
  return stroke.points.some((p, i) => {
    const a = stroke.points[Math.max(0,i-1)], dx = p.x-a.x, dy = p.y-a.y;
    const t = Math.max(0, Math.min(1, ((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(x-a.x-t*dx,y-a.y-t*dy) < radius+stroke.width/2;
  });
}
// Bounded backing store even for long native pages; source coordinates stay intact.
export function inkCanvasSize(doc: InkDocument) {
  const scale = Math.min(1, 4096/doc.width, 16384/doc.height, Math.sqrt(4_194_304/(doc.width*doc.height)));
  return { width: Math.max(1, Math.ceil(doc.width*scale)), height: Math.max(1, Math.ceil(doc.height*scale)) };
}
export function paintInk(canvas: HTMLCanvasElement, doc: InkDocument) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Drawing canvas is unavailable");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const layer = document.createElement("canvas"); layer.width = canvas.width; layer.height = canvas.height;
  const c = layer.getContext("2d");
  if (!c) throw new Error("Drawing canvas is unavailable");
  for (const stroke of doc.portable.strokes) {
    c.resetTransform(); c.clearRect(0, 0, layer.width, layer.height);
    c.save(); c.scale(canvas.width/doc.width, canvas.height/doc.height);
    c.strokeStyle = stroke.color; c.fillStyle = stroke.color; c.lineCap = "round";
    if ("kind" in stroke) {
      // Clip in drawing space; only sampled nibs use the stroke transform.
      const path = clipPath(stroke); if (path) c.clip(path, stroke.maskUsesEvenOddFillRule ? "evenodd" : "nonzero");
      const [a,b,d,e,x,y] = stroke.transform; c.transform(a,b,d,e,x,y);
      for (const p of stroke.points) {
        c.globalAlpha = p.opacity;
        c.beginPath(); c.ellipse(p.x,p.y,p.width/2,p.height/2,p.azimuth,0,Math.PI*2); c.fill();
      }
      ctx.globalAlpha = stroke.alpha * (stroke.tool === "marker" ? .35 : 1);
    } else {
      let previous = stroke.points[0];
      for (const p of stroke.points) {
        c.lineWidth = stroke.width * (.25 + .75 * p.pressure);
        c.beginPath(); c.moveTo(previous.x, previous.y); c.lineTo(p.x, p.y); c.stroke();
        c.beginPath(); c.arc(p.x, p.y, c.lineWidth/2, 0, Math.PI*2); c.fill(); previous = p;
      }
      ctx.globalAlpha = stroke.tool === "marker" ? .35 : 1;
    }
    c.restore(); ctx.drawImage(layer, 0, 0);
  }
  ctx.globalAlpha = 1;
}
