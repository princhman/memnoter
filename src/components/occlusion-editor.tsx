import { useEffect, useRef, useState, type PointerEvent } from "react";
import { drawMask, normalizedPoint, validMasks, type Mask, type Point } from "@/lib/occlusion";
import { Button } from "@/components/ui/button";

export function MaskShape({ mask, ...props }: { mask: Mask } & Omit<React.SVGProps<SVGElement>, "mask">) {
  if (mask.shape === "rectangle") return <rect x={mask.x} y={mask.y} width={mask.width} height={mask.height} {...props as React.SVGProps<SVGRectElement>} />;
  if (mask.shape === "ellipse") return <ellipse cx={mask.cx} cy={mask.cy} rx={mask.rx} ry={mask.ry} {...props as React.SVGProps<SVGEllipseElement>} />;
  return <polygon points={mask.points.map(p => `${p.x},${p.y}`).join(" ")} {...props as React.SVGProps<SVGPolygonElement>} />;
}

export function OcclusionEditor({ src, masks: initial, onCancel, onSave }: { src: string; masks: Mask[]; onCancel: () => void; onSave: (masks: Mask[]) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [masks, setMasks] = useState(initial);
  const [history, setHistory] = useState<Mask[][]>([]);
  const [selected, setSelected] = useState<string>();
  const [tool, setTool] = useState<Mask["shape"] | "select">("rectangle");
  const [draft, setDraft] = useState<Mask>();
  const [error, setError] = useState("");
  const gesture = useRef<{ points: Point[]; id: string } | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const commit = (next: Mask[]) => { setHistory(h => [...h, masks]); setMasks(next); setError(""); };
  const point = (e: PointerEvent<SVGSVGElement>) => normalizedPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
  const target = masks.find(m => m.id === selected);
  return <dialog ref={dialog} className="occlusion-dialog" aria-labelledby="occlusion-title" onCancel={e => { e.preventDefault(); onCancel(); }}>
    <h2 id="occlusion-title">Image occlusion</h2>
    <p>Draw masks, then select one to edit its normalized coordinates. Only the target is hidden during review; other answers stay visible.</p>
    <div className="flex flex-wrap gap-2 my-3">{(["select", "rectangle", "ellipse", "freehand"] as const).map(t => <Button key={t} variant={tool === t ? "default" : "outline"} aria-pressed={tool === t} onClick={() => setTool(t)}>{t}</Button>)}
      <Button disabled={!history.length} onClick={() => { setMasks(history[history.length - 1]); setHistory(h => h.slice(0,-1)); }}>Undo</Button>
    </div>
    <div className="occlusion-frame">
      <img src={src} alt="Image to mask" draggable={false} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Draw occlusion masks" onPointerDown={e => {
        if (tool === "select") return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
        gesture.current = { points: [point(e)], id: crypto.randomUUID() };
      }} onPointerMove={e => {
        const g = gesture.current; if (!g || tool === "select") return;
        const p = point(e);
        g.points = tool === "freehand" ? [...g.points.slice(0,4094), p] : [g.points[0], p];
        setDraft(drawMask(tool, g.points, g.id));
      }} onPointerUp={e => {
        const g = gesture.current; if (!g || tool === "select") return;
        const m = drawMask(tool, [...g.points, point(e)], g.id);
        if (validMasks([m]).length) { commit([...masks, m]); setSelected(m.id); }
        gesture.current = null; setDraft(undefined);
      }} onPointerCancel={() => { gesture.current = null; setDraft(undefined); }}>
        {[...masks, ...(draft ? [draft] : [])].map((m,i) => <MaskShape key={m.id} mask={m} fill={m.id === selected ? "#e9a23b" : "#557bcd"} fillOpacity={0.65} stroke="white" strokeWidth={0.003} onPointerDown={e => { if (tool === "select") { e.stopPropagation(); setSelected(m.id); } }}><title>Mask {i + 1}</title></MaskShape>)}
      </svg>
    </div>
    <div className="flex flex-wrap gap-2 my-3">{masks.map((m,i) => <Button key={m.id} variant="outline" aria-pressed={selected === m.id} onClick={() => { setSelected(m.id); setTool("select"); }}>Mask {i+1} ({m.shape})</Button>)}</div>
    <Button onClick={() => { const m = drawMask(tool === "select" ? "rectangle" : tool, tool === "freehand" ? [{x:.25,y:.25},{x:.75,y:.25},{x:.5,y:.75}] : [{x:.25,y:.25},{x:.75,y:.75}], crypto.randomUUID()); commit([...masks,m]); setSelected(m.id); }}>Add centered mask (keyboard)</Button>
    {target && <fieldset key={`${target.id}-${history.length}`} className="my-3"><legend>Edit selected {target.shape}</legend>
      {target.shape === "freehand" ? <label>Closed path points (JSON, x/y from 0 to 1)<textarea defaultValue={JSON.stringify(target.points)} onBlur={e => {
        try { const next = { ...target, points: JSON.parse(e.target.value) }; if (!validMasks([next]).length) throw Error(); commit(masks.map(m => m.id === target.id ? next : m)); } catch { setError("Enter at least three valid points forming a closed area, with coordinates from 0 to 1."); }
      }} /></label> : Object.entries(target).filter(([k]) => !["id","shape"].includes(k)).map(([key,value]) => <label key={key} className="inline-flex gap-2 mr-3">{key}<input type="number" min="0" max="1" step="0.01" defaultValue={value as number} onBlur={e => {
        const next = { ...target, [key]: Number(e.target.value) };
        if (validMasks([next]).length) commit(masks.map(m => m.id === target.id ? next : m)); else setError("The mask must have a positive area and fit inside the image (0–1).");
      }} /></label>)}
      <Button variant="destructive" onClick={() => { commit(masks.filter(m => m.id !== selected)); setSelected(undefined); }}>Delete selected mask</Button>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    <div className="flex justify-end gap-2 mt-4"><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button onClick={() => onSave(masks)}>Save masks</Button></div>
  </dialog>;
}
