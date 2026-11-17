import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { call } from "@/lib/backend";
import type { FileType } from "@/lib/content";
import { parseInk, paintInk, hitInk, inkCanvasSize, type InkDocument, type InkStroke } from "@/lib/portable-ink";
import { Button } from "./ui/button";

type Request = { moduleId: string; imageId: string; sourceId?: string | null; displayLabel?: string };
export type DrawingResult = { status: "save" | "cancel"; source?: FileType; preview?: FileType; width?: number; height?: number; expectedSourceId: string | null; asCopy: boolean; hasChanges: boolean };
const key = (r: Request) => `portable-ink:${JSON.stringify([r.moduleId, r.imageId])}`;
export function acknowledgePortableDrawing(r: Request) { localStorage.removeItem(key(r)); }
let active = false;
export async function openPortableDrawing(request: Request): Promise<DrawingResult> {
  if (active) throw new Error("Close the current drawing first.");
  active = true;
  try {
    const retained = localStorage.getItem(key(request));
    let initial: InkDocument = { version: 2, nativeData: "", width: 1024, height: 1440, portable: { version: 1, strokes: [] } };
    let base = request.sourceId ?? null;
    if (retained) {
      const draft: unknown = JSON.parse(retained);
      if (!draft || typeof draft !== "object" || !("document" in draft) || !("base" in draft) || (draft.base !== null && typeof draft.base !== "string")) throw new Error("The local drawing draft cannot be read. Its data has been retained.");
      initial = parseInk(draft.document); base = draft.base;
    } else if (request.sourceId) {
      const file = await call<{ bytes: number[] }>("read_file", { moduleId: request.moduleId, fileId: request.sourceId });
      initial = parseInk(JSON.parse(new TextDecoder().decode(new Uint8Array(file.bytes))));
    }
    return await new Promise<DrawingResult>(resolve => {
      const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
      const finish = (result: DrawingResult) => { root.unmount(); host.remove(); resolve(result); };
      root.render(<PortableDrawing request={request} initial={initial} base={base} recovered={!!retained} finish={finish} />);
    });
  } finally { active = false; }
}
function PortableDrawing({ request, initial, base, recovered, finish }: { request: Request; initial: InkDocument; base: string | null; recovered: boolean; finish: (r: DrawingResult) => void }) {
  const [ink, setInk] = useState(initial);
  const current = useRef(ink); current.current = ink;
  const [undo, setUndo] = useState<InkDocument[]>([]), [redo, setRedo] = useState<InkDocument[]>([]);
  const [tool, setTool] = useState<"pen" | "marker" | "eraser">("pen"), [color, setColor] = useState("#202020"), [width, setWidth] = useState(4), [touch, setTouch] = useState(false);
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const changed = useRef(recovered);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const host = dialog.current?.parentElement;
    const siblings = Array.from(document.body.children).filter(el => el !== host && !el.hasAttribute("inert"));
    siblings.forEach(el => el.setAttribute("inert", ""));
    dialog.current?.focus();
    return () => { siblings.forEach(el => el.removeAttribute("inert")); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const gesture = useRef<{ id: number; before: InkDocument; stroke: InkStroke | null } | null>(null);
  useEffect(() => { if (canvas.current) paintInk(canvas.current, ink); }, [ink]);
  const checkpoint = (next: InkDocument) => {
    try { localStorage.setItem(key(request), JSON.stringify({ document: next, base })); setError(""); return true; }
    catch { setError("Local draft storage is full. Keep this window open and use Done to save."); return false; }
  };
  const update = (next: InkDocument) => { current.current = next; setInk(next); changed.current = true; checkpoint(next); };
  const cancel = () => { const g = gesture.current; if (g) { gesture.current = null; update(g.before); } };
  const sample = (e: PointerEvent, start = false) => {
    const g = gesture.current, c = canvas.current; if (!g || !c || e.pointerId !== g.id) return;
    const rect = c.getBoundingClientRect();
    const x = Math.max(0, Math.min(ink.width, (e.clientX - rect.left) * ink.width / rect.width));
    const y = Math.max(0, Math.min(ink.height, (e.clientY - rect.top) * ink.height / rect.height));
    if (g.stroke) {
      g.stroke.points.push({ x, y, pressure: e.pointerType === "mouse" ? .75 : Math.max(.05, e.pressure) });
      update({ ...g.before, portable: { version: g.before.portable.version, strokes: [...g.before.portable.strokes, g.stroke] } });
    } else {
      const doc = start ? g.before : current.current;
      update({ ...doc, portable: { version: doc.portable.version, strokes: doc.portable.strokes.filter(s => !hitInk(s, x, y)) } });
    }
  };
  const close = () => { cancel(); if (changed.current && !checkpoint(current.current)) return; finish({ status: "cancel", hasChanges: changed.current, expectedSourceId: base, asCopy: false }); };
  const save = async () => {
    if (gesture.current) return;
    setSaving(true); setError("");
    try {
      const doc = parseInk({ ...current.current, version: 2 });
      const source = await call<FileType>("save_file", { moduleId: request.moduleId, bytes: Array.from(new TextEncoder().encode(JSON.stringify(doc))), mimeType: "application/vnd.memnoter.drawing+json" });
      const png = await new Promise<Blob>((resolve, reject) => canvas.current!.toBlob(b => b ? resolve(b) : reject(new Error("Preview failed")), "image/png"));
      const preview = await call<FileType>("save_file", { moduleId: request.moduleId, bytes: Array.from(new Uint8Array(await png.arrayBuffer())), mimeType: "image/png" });
      finish({ status: "save", source, preview, width: doc.width, height: doc.height, expectedSourceId: base, asCopy: base !== (request.sourceId ?? null), hasChanges: changed.current });
    } catch (e) { setError(String(e)); setSaving(false); }
  };
  return <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Drawing editor" className="fixed inset-0 z-[100] flex flex-col bg-background text-foreground" onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Tab") {
        const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
      if (e.key === "Escape" && !saving) { e.stopPropagation(); close(); } }}>
    <div className="flex flex-wrap items-center gap-2 p-3">
      <span>{request.displayLabel ? `Question ${request.displayLabel}` : "Drawing"}</span>
      {(["pen", "marker", "eraser"] as const).map(t => <Button key={t} variant={tool === t ? "default" : "ghost"} disabled={saving} onClick={() => setTool(t)}>{t[0].toUpperCase()+t.slice(1)}</Button>)}
      <input aria-label="Ink color" type="color" value={color} onChange={e => setColor(e.target.value)} />
      <input aria-label="Ink width" type="range" min="1" max="24" value={width} onChange={e => setWidth(Number(e.target.value))} />
      <label><input type="checkbox" checked={touch} onChange={e => setTouch(e.target.checked)} /> Touch drawing</label>
      <Button variant="ghost" disabled={!undo.length || saving} onClick={() => { const previous = undo[undo.length-1]; setRedo([...redo, ink]); setUndo(undo.slice(0,-1)); update(previous); }}>Undo</Button>
      <Button variant="ghost" disabled={!redo.length || saving} onClick={() => { const next = redo[redo.length-1]; setUndo([...undo, ink]); setRedo(redo.slice(0,-1)); update(next); }}>Redo</Button>
      <Button variant="ghost" disabled={saving} onClick={close}>Close</Button><Button disabled={saving} onClick={() => void save()}>Done</Button>
    </div>
    <p className="px-3 text-sm text-muted-foreground">{recovered ? "Recovered local draft. " : ""}Round pen and translucent marker; eraser removes whole strokes. Close keeps a local draft. Scroll to move down the paper.</p>
    {error && <p role="alert" className="p-3 text-destructive">{error}</p>}
    <div className="flex-1 overflow-auto bg-muted p-4">
      <canvas ref={canvas} aria-label="Drawing paper" width={inkCanvasSize(ink).width} height={inkCanvasSize(ink).height} className="mx-auto block bg-white" style={{ width: "min(100%, 1024px)", aspectRatio: `${ink.width} / ${ink.height}`, touchAction: touch ? "none" : "pan-y" }}
        onPointerEnter={e => { if (e.pointerType === "pen") e.currentTarget.style.touchAction = "none"; }}
        onPointerDown={e => {
          if (saving || gesture.current || e.button !== 0 || (e.pointerType === "touch" && (!touch || !e.isPrimary || e.width > 30 || e.height > 30))) return;
          e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
          const before = current.current; gesture.current = { id: e.pointerId, before, stroke: tool === "eraser" ? null : { tool, color, width, points: [] } };
          sample(e.nativeEvent, true);
        }}
        onPointerMove={e => { if (gesture.current?.id !== e.pointerId) return; const events = e.nativeEvent.getCoalescedEvents?.() ?? []; for (const event of events.length ? events : [e.nativeEvent]) sample(event); }}
        onPointerUp={e => { const g = gesture.current; if (!g || g.id !== e.pointerId) return; sample(e.nativeEvent); gesture.current = null; setUndo([...undo, g.before]); setRedo([]); }}
        onPointerCancel={e => { if (gesture.current?.id === e.pointerId) cancel(); }} onLostPointerCapture={e => { if (gesture.current?.id === e.pointerId) cancel(); }} />
      <Button className="mx-auto mt-3 block" variant="ghost" disabled={ink.height >= 8192 || saving} onClick={() => { setUndo([...undo, ink]); setRedo([]); update({ ...ink, height: ink.height + 1440 }); }}>Add paper</Button>
    </div>
  </div>;
}
