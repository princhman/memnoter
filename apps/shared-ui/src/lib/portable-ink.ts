// Native descriptors approximate rendering only. Indexed PKStrokes in the
// immutable nativeData basis retain masks, texture and editable native fidelity.
export type InkPoint = { x: number; y: number; pressure: number };
export type InkStroke = { tool: "pen" | "pencil" | "marker"; color: string; width: number; points: InkPoint[] };
type MaskElement = { command: "move" | "line" | "quadratic" | "cubic" | "close"; coordinates: number[] };
export type NativeStroke = {
  kind: "native"; nativeIndex: number; tool: string; color: string; width: number; alpha: number;
  transform: number[]; mask: MaskElement[] | null; maskUsesEvenOddFillRule: boolean;
  cuts?: MaskElement[][];
  points: (InkPoint & { width: number; height: number; opacity: number; azimuth: number })[];
};
export type PortableStroke = InkStroke | NativeStroke;
export type PortableInk = { version: 1 | 2; strokes: PortableStroke[] };
export type PaperStyle = "blank" | "lined" | "grid";
export type InkDocument = { version: 1 | 2; nativeData: string; width: number; height: number; geometry?: string | null; paperStyle: PaperStyle; portable: PortableInk };
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
      const parseMask = (value: unknown) => {
        if (!Array.isArray(value)) return fail();
        return value.map((value: unknown): MaskElement => {
          if (++masks > 500000) return fail();
          const e = record(value), c = e.command;
          const length = c === "move" || c === "line" ? 2 : c === "quadratic" ? 4 : c === "cubic" ? 6 : c === "close" ? 0 : -1;
          if ((c !== "move" && c !== "line" && c !== "quadratic" && c !== "cubic" && c !== "close") || !Array.isArray(e.coordinates) || e.coordinates.length !== length || !e.coordinates.every(n => finite(n, -1_000_000, 1_000_000))) return fail();
          return { command: c, coordinates: e.coordinates };
        });
      };
      const mask = s.mask == null ? null : parseMask(s.mask);
      const cuts = s.cuts == null ? undefined : Array.isArray(s.cuts)
        ? s.cuts.map(cut => { const path = parseMask(cut); return path.length ? path : fail(); }) : fail();
      return { kind: "native", nativeIndex: s.nativeIndex, tool: s.tool, color: s.color, width: s.width, alpha: s.alpha,
        transform: s.transform, mask, ...(cuts && { cuts }), maskUsesEvenOddFillRule: s.maskUsesEvenOddFillRule,
        points: points.map(p => {
          if (!finite(p.width, 0, 1000) || !finite(p.height, 0, 1000) || !finite(p.opacity, 0, 1) || !finite(p.azimuth, -1000, 1000)) return fail();
          return { ...p, width: p.width, height: p.height, opacity: p.opacity, azimuth: p.azimuth };
        }) };
    }
    if (s.kind !== undefined || s.nativeIndex !== undefined || s.transform !== undefined || s.mask !== undefined || s.cuts !== undefined || s.alpha !== undefined || (s.tool !== "pen" && s.tool !== "pencil" && s.tool !== "marker") || s.width > 100) return fail();
    return { tool: s.tool, color: s.color, width: s.width, points: points.map(({ x, y, pressure }) => ({ x, y, pressure })) };
  });
  const paperStyle = v.paperStyle === "lined" || v.paperStyle === "grid" ? v.paperStyle : "blank";
  return { paperStyle, version: v.version, nativeData: v.nativeData, width: v.width, height: v.height, geometry: typeof v.geometry === "string" ? v.geometry : null, portable: { version: ink.version, strokes } };
}
function maskPath(elements: MaskElement[]): Path2D {
  const path = new Path2D();
  for (const e of elements) {
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
function drawingMask(stroke: NativeStroke): Path2D | null {
  if (!stroke.mask) return null;
  const path = new Path2D();
  path.addPath(maskPath(stroke.mask), new DOMMatrix(stroke.transform));
  return path;
}
export function hitInk(stroke: PortableStroke, x: number, y: number): boolean {
  let radius = 12;
  if ("kind" in stroke) {
    const [a,b,c,d,e,f] = stroke.transform, det = a*d-b*c;
    if (!det) return false;
    // The native clip follows the stroke transform.
    const path = drawingMask(stroke);
    const ctx = document.createElement("canvas").getContext("2d");
    if (path && !ctx?.isPointInPath(path, x, y, stroke.maskUsesEvenOddFillRule ? "evenodd" : "nonzero")) return false;
    if (stroke.cuts?.some(cut => ctx?.isPointInPath(maskPath(cut), x, y, "evenodd"))) return false;
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
export type InkPosition = Pick<InkPoint, "x" | "y">;

export function insideLasso(point: InkPosition, loop: InkPosition[]) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < a.x + (b.x - a.x) * (point.y - a.y) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

export function lassoInk(stroke: PortableStroke, loop: InkPosition[]) {
  if (!("kind" in stroke)) return stroke.points.filter(p => insideLasso(p, loop)).length > stroke.points.length / 2;
  const [a, b, c, d, x, y] = stroke.transform;
  const mask = drawingMask(stroke);
  const cuts = stroke.cuts?.map(maskPath);
  const context = mask || cuts?.length ? document.createElement("canvas").getContext("2d") : null;
  let visible = 0, inside = 0;
  for (const p of stroke.points) {
    const point = { x: a * p.x + c * p.y + x, y: b * p.x + d * p.y + y };
    if (!p.opacity || !stroke.alpha || (mask && !context?.isPointInPath(mask, point.x, point.y,
      stroke.maskUsesEvenOddFillRule ? "evenodd" : "nonzero")) || cuts?.some(cut => context?.isPointInPath(cut, point.x, point.y, "evenodd"))) continue;
    visible++;
    if (insideLasso(point, loop)) inside++;
  }
  return inside > visible / 2;
}

export function translateInk(stroke: PortableStroke, dx: number, dy: number): PortableStroke {
  if (!("kind" in stroke)) {
    return { ...stroke, points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
  }
  const [a, b, c, d, x, y] = stroke.transform;
  const moveMask = (mask: MaskElement[]) => mask.map(element => ({
    ...element, coordinates: element.coordinates.map((value, i) => value + (i % 2 ? dy : dx)),
  }));
  return {
    ...stroke,
    transform: [a, b, c, d, x + dx, y + dy],
    ...(stroke.cuts && { cuts: stroke.cuts.map(moveMask) }),
  };
}

function interpolatePoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
  if (t === 0) return a;
  if (t === 1) return b;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: b.pressure };
}

// Intersect an ink segment with the eraser's swept disk. The capsule is
// convex, so the end disks and connecting rectangle form one cut interval.
function eraserInterval(a: InkPoint, b: InkPoint, from: InkPosition, to: InkPosition, radius: number) {
  if (Math.min(a.x, b.x) > Math.max(from.x, to.x) + radius ||
      Math.max(a.x, b.x) < Math.min(from.x, to.x) - radius ||
      Math.min(a.y, b.y) > Math.max(from.y, to.y) + radius ||
      Math.max(a.y, b.y) < Math.min(from.y, to.y) - radius) return null;

  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let enter = Infinity, exit = -Infinity;
  const include = (lo: number, hi: number) => {
    lo = Math.max(0, lo);
    hi = Math.min(1, hi);
    if (lo <= hi) {
      enter = Math.min(enter, lo);
      exit = Math.max(exit, hi);
    }
  };
  for (const center of [from, to]) {
    const x = a.x - center.x, y = a.y - center.y;
    if (lengthSquared === 0) {
      if (Math.hypot(x, y) <= radius) include(0, 1);
      continue;
    }
    const closest = -(x * dx + y * dy) / lengthSquared;
    const remaining = radius * radius - (x + closest * dx) ** 2 - (y + closest * dy) ** 2;
    if (remaining >= 0) {
      const half = Math.sqrt(remaining / lengthSquared);
      include(closest - half, closest + half);
    }
  }
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length) {
    const ux = (to.x - from.x) / length, uy = (to.y - from.y) / length;
    const x = a.x - from.x, y = a.y - from.y;
    let lo = 0, hi = 1;
    for (const [position, velocity, min, max] of [
      [x * ux + y * uy, dx * ux + dy * uy, 0, length],
      [y * ux - x * uy, dy * ux - dx * uy, -radius, radius],
    ]) {
      if (velocity === 0) {
        if (position < min || position > max) hi = -1;
      } else {
        const t0 = (min - position) / velocity, t1 = (max - position) / velocity;
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
    }
    include(lo, hi);
  }
  return enter < exit ? { enter, exit } : null;
}

export function eraseInkPixels(stroke: PortableStroke, from: InkPosition, to: InkPosition, radius: number): PortableStroke[] {
  if ("kind" in stroke) {
    const [a, b, c, d, x, y] = stroke.transform;
    const scale = Math.hypot(a, b, c, d);
    const points = stroke.points.map(p => ({
      x: a * p.x + c * p.y + x, y: b * p.x + d * p.y + y,
      pressure: p.pressure, radius: scale * Math.max(p.width, p.height) / 2,
    }));
    if (!points.some((p, i) => {
      const prev = points[Math.max(0, i - 1)];
      return eraserInterval(prev, p, from, to, radius + Math.max(prev.radius, p.radius));
    })) return [stroke];
    // Store the swept disk as one closed path. Each sweep subtracts independently.
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const cut: MaskElement[] = [];
    for (const [center, start] of [[to, angle - Math.PI / 2], [from, angle + Math.PI / 2]] as const) {
      for (let i = 0; i <= 16; i++) {
        const theta = start + i * Math.PI / 16;
        cut.push({ command: cut.length ? "line" : "move",
          coordinates: [center.x + radius * Math.cos(theta), center.y + radius * Math.sin(theta)] });
      }
    }
    cut.push({ command: "close", coordinates: [] });
    if (cut.some(e => e.coordinates.some(n => !finite(n, -1_000_000, 1_000_000)))) return [stroke];
    return [{ ...stroke, cuts: [...(stroke.cuts ?? []), cut] }];
  }
  const width = stroke.width * (stroke.tool === "pencil" ? .65 : 1);
  const nibRadius = (p: InkPoint) => width * (.25 + .75 * p.pressure) / 2;
  const pieces: InkStroke[] = [];
  let points: InkPoint[] = [];
  let cut = false;
  const finish = () => {
    if (points.length) pieces.push({ ...stroke, points });
    points = [];
  };
  for (let i = 0; i < stroke.points.length; i++) {
    const b = stroke.points[i], a = stroke.points[Math.max(0, i - 1)];
    const interval = eraserInterval(a, b, from, to, radius + Math.max(nibRadius(a), nibRadius(b)));
    if (!interval) {
      if (i && !points.length) points.push(a);
      points.push(b);
      continue;
    }
    cut = true;
    if (interval.enter > 0) {
      if (!points.length) points.push(a);
      points.push(interpolatePoint(a, b, interval.enter));
    }
    finish();
    if (interval.exit < 1) points.push(interpolatePoint(a, b, interval.exit), b);
  }
  finish();
  return cut ? pieces : [stroke];
}

// Bounded backing store even for long native pages; source coordinates stay intact.
export function inkCanvasSize(doc: Pick<InkDocument, "width" | "height">, scaleX = 1, scaleY = scaleX) {
  const width = doc.width * scaleX, height = doc.height * scaleY;
  const limit = Math.min(1, 4096 / width, 16384 / height,
    4_194_304 / width, 4_194_304 / height, Math.sqrt(4_194_304 / (width * height)));
  return { width: Math.max(1, Math.floor(width * limit)), height: Math.max(1, Math.floor(height * limit)) };
}
function paintRuling(ctx: CanvasRenderingContext2D, doc: InkDocument, exporting: boolean, top: number, height: number) {
  if (doc.paperStyle === "blank") return;
  ctx.save();
  ctx.scale(ctx.canvas.width / doc.width, ctx.canvas.height / height);
  ctx.translate(0, -top);
  ctx.lineWidth = exporting ? 1 : .5;
  ctx.strokeStyle = exporting ? "#999999" : "rgba(0, 0, 0, .22)";
  ctx.beginPath();
  for (let y = Math.ceil(top / 28) * 28; y <= Math.min(doc.height, top + height); y += 28) {
    ctx.moveTo(0, y);
    ctx.lineTo(doc.width, y);
  }
  if (doc.paperStyle === "grid") {
    for (let x = 0; x <= doc.width; x += 28) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, doc.height);
    }
  }
  ctx.stroke();
  ctx.restore();
}
export function paintInk(canvas: HTMLCanvasElement, doc: InkDocument, exporting = false, crop = { top: 0, height: doc.height }) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Drawing canvas is unavailable");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  paintRuling(ctx, doc, exporting, crop.top, crop.height);
  const layer = document.createElement("canvas"); layer.width = canvas.width; layer.height = canvas.height;
  const c = layer.getContext("2d");
  if (!c) throw new Error("Drawing canvas is unavailable");
  for (const stroke of doc.portable.strokes) {
    c.resetTransform(); c.clearRect(0, 0, layer.width, layer.height);
    c.save(); c.scale(canvas.width/doc.width, canvas.height/crop.height); c.translate(0, -crop.top);
    c.strokeStyle = stroke.color; c.fillStyle = stroke.color; c.lineCap = "round";
    if ("kind" in stroke) {
      // Transform the native clip into the same drawing space as the cuts.
      const path = drawingMask(stroke); if (path) c.clip(path, stroke.maskUsesEvenOddFillRule ? "evenodd" : "nonzero");
      for (const cut of stroke.cuts ?? []) {
        const complement = new Path2D();
        complement.rect(-1_000_001, -1_000_001, 2_000_002, 2_000_002);
        complement.addPath(maskPath(cut));
        c.clip(complement, "evenodd");
      }
      const [a,b,d,e,x,y] = stroke.transform; c.transform(a,b,d,e,x,y);
      for (const p of stroke.points) {
        c.globalAlpha = p.opacity;
        c.beginPath(); c.ellipse(p.x,p.y,p.width/2,p.height/2,p.azimuth,0,Math.PI*2); c.fill();
      }
      ctx.globalAlpha = stroke.alpha * (stroke.tool === "marker" ? .35 : 1);
    } else {
      const width = stroke.tool === "pencil" ? stroke.width * .65 : stroke.width;
      let previous = stroke.points[0];
      for (const p of stroke.points) {
        c.lineWidth = width * (.25 + .75 * p.pressure);
        c.beginPath(); c.moveTo(previous.x, previous.y); c.lineTo(p.x, p.y); c.stroke();
        c.beginPath(); c.arc(p.x, p.y, c.lineWidth/2, 0, Math.PI*2); c.fill(); previous = p;
      }
      ctx.globalAlpha = stroke.tool === "marker" ? .35 : stroke.tool === "pencil" ? .75 : 1;
    }
    c.restore(); ctx.drawImage(layer, 0, 0);
  }
  ctx.globalAlpha = 1;
}
