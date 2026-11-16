// Canonical portable ink: page-space polylines, round nib, whole-stroke erase.
// PencilKit spline inspection geometry is deliberately NOT accepted here.
export type InkPoint = { x: number; y: number; pressure: number };
export type InkStroke = { tool: "pen" | "marker"; color: string; width: number; points: InkPoint[] };
export type PortableInk = { version: 1; strokes: InkStroke[] };
export type InkDocument = { version: 1 | 2; nativeData: string; width: number; height: number; geometry?: string | null; portable: PortableInk };
const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function parseInk(value: unknown): InkDocument {
  const fail = () => { throw new Error("This drawing contains unsupported or legacy native ink. Edit it on an updated Apple device first; its source has not been changed."); };
  if (!value || typeof value !== "object" || !("version" in value) || (value.version !== 1 && value.version !== 2) || !("nativeData" in value) || typeof value.nativeData !== "string" || !("width" in value) || !finite(value.width, 1, 4096) || !("height" in value) || !finite(value.height, 1, 16384) || !("portable" in value)) return fail();
  if (value.width * value.height > 16_777_216) return fail();
  const ink = value.portable;
  if (!ink || typeof ink !== "object" || !("version" in ink) || ink.version !== 1 || !("strokes" in ink) || !Array.isArray(ink.strokes) || ink.strokes.length > 20000) return fail();
  let count = 0;
  const strokes: InkStroke[] = ink.strokes.map((s: unknown) => {
    if (!s || typeof s !== "object" || !("tool" in s) || (s.tool !== "pen" && s.tool !== "marker") || !("color" in s) || typeof s.color !== "string" || !/^#[0-9a-f]{6}$/i.test(s.color) || !("width" in s) || !finite(s.width, .1, 100) || !("points" in s) || !Array.isArray(s.points) || !s.points.length) return fail();
    const points: InkPoint[] = s.points.map((p: unknown) => {
      if (!p || typeof p !== "object" || !("x" in p) || !finite(p.x, 0, 4096) || !("y" in p) || !finite(p.y, 0, 16384) || !("pressure" in p) || !finite(p.pressure, 0, 1) || ++count > 500000) return fail();
      return { x: p.x, y: p.y, pressure: p.pressure };
    });
    return { tool: s.tool, color: s.color, width: s.width, points };
  });
  return { version: value.version, nativeData: value.nativeData, width: value.width, height: value.height, geometry: "geometry" in value && typeof value.geometry === "string" ? value.geometry : null, portable: { version: 1, strokes } };
}
export function paintInk(canvas: HTMLCanvasElement, document: InkDocument) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Drawing canvas is unavailable");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const layer = window.document.createElement("canvas"); layer.width = canvas.width; layer.height = canvas.height;
  const c = layer.getContext("2d");
  if (!c) throw new Error("Drawing canvas is unavailable");
  for (const stroke of document.portable.strokes) {
    // Composite marker once per stroke, avoiding darker overlapping segments.
    c.clearRect(0, 0, layer.width, layer.height); c.strokeStyle = stroke.color; c.fillStyle = stroke.color; c.lineCap = "round";
    let previous = stroke.points[0];
    for (const p of stroke.points) {
      c.lineWidth = stroke.width * (.25 + .75 * p.pressure);
      c.beginPath(); c.moveTo(previous.x, previous.y); c.lineTo(p.x, p.y); c.stroke();
      c.beginPath(); c.arc(p.x, p.y, c.lineWidth / 2, 0, Math.PI * 2); c.fill(); previous = p;
    }
    ctx.globalAlpha = stroke.tool === "marker" ? .35 : 1; ctx.drawImage(layer, 0, 0);
  }
  ctx.globalAlpha = 1;
}
