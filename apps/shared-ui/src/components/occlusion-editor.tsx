import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { action, formatKeys } from "@/lib/shortcuts";
import { IconTooltip } from "@/components/icon-tooltip";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Circle, Combine, MousePointer2, PenLine, Split, Square, Trash2, Undo2 } from "lucide-react";
import { drawMask, maskBounds, maskCards, normalizedPoint, validMasks, withBounds, type Mask, type Point } from "@/lib/occlusion";
import { HANDLES, moveBox, resizeBox, type Handle } from "@/lib/box";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function MaskShape({ mask, ...props }: { mask: Mask } & Omit<React.SVGProps<SVGElement>, "mask">) {
  if (mask.shape === "rectangle") return <rect x={mask.x} y={mask.y} width={mask.width} height={mask.height} {...props as React.SVGProps<SVGRectElement>} />;
  if (mask.shape === "ellipse") return <ellipse cx={mask.cx} cy={mask.cy} rx={mask.rx} ry={mask.ry} {...props as React.SVGProps<SVGEllipseElement>} />;
  return <polygon points={mask.points.map(p => `${p.x},${p.y}`).join(" ")} {...props as React.SVGProps<SVGPolygonElement>} />;
}

type Tool = Mask["shape"] | "select";
const TOOLS: { tool: Tool; label: string; key: string; Icon: typeof Square }[] = [
  { tool: "select", label: "Select", key: "V", Icon: MousePointer2 },
  { tool: "rectangle", label: "Rectangle", key: "R", Icon: Square },
  { tool: "ellipse", label: "Ellipse", key: "E", Icon: Circle },
  { tool: "freehand", label: "Freehand", key: "F", Icon: PenLine },
];
// Smaller masks are taken for a stray click, not a mask.
const MIN_SIZE = 0.01;
// Arrow keys move the selected mask by this, or ten times it with Shift.
const NUDGE = 0.005;

// A drag on the image: drawing a new mask, or moving or resizing one.
type Gesture =
  | { kind: "draw"; pointerId: number; id: string; points: Point[] }
  | { kind: "edit"; pointerId: number; ids: string[]; start: Point; before: Mask[]; mode: "move" | Handle; toggle?: { id: string; selection: string[] } };

export function OcclusionEditor({ src, masks: initial, onCancel, onSave }: { src: string; masks: Mask[]; onCancel: () => void; onSave: (masks: Mask[]) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [masks, setMasks] = useState(initial);
  const [history, setHistory] = useState<Mask[][]>([]);
  // Several masks can be selected, with Shift, to join or move them together.
  const [selected, setSelected] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("rectangle");
  const [draft, setDraft] = useState<Mask>();
  const gesture = useRef<Gesture | null>(null);

  // Each change is one undo step; a drag is one change, made when it ends.
  const commit = (next: Mask[], before = masks) => { setHistory(h => [...h, before]); setMasks(next); };
  const undo = () => {
    if (!history.length) return;
    setMasks(history[history.length - 1]);
    setHistory(h => h.slice(0, -1));
  };
  const remove = () => {
    if (!selected.length) return;
    commit(masks.filter(m => !selected.includes(m.id)));
    setSelected([]);
  };
  const point = (e: PointerEvent) => normalizedPoint(e.clientX, e.clientY, frame.current!.getBoundingClientRect());
  // Resize handles are for a single selected mask.
  const target = selected.length === 1 ? masks.find(m => m.id === selected[0]) : undefined;

  // Each card's number; joined masks share one. Same order as the cards.
  const cards = maskCards(masks);
  const cardNumber = new Map(cards.flatMap(({ members }, i) => members.map(m => [m.id, i + 1] as const)));
  // The selected masks with the rest of their groups.
  const selectedGroups = () => {
    const keys = new Set(cards.filter(({ members }) => members.some(m => selected.includes(m.id))).map(({ owner }) => owner.id));
    return cards.filter(({ owner }) => keys.has(owner.id));
  };
  // The first selected mask's card owns the joined card, so its schedule is kept.
  const join = () => {
    const groups = selectedGroups();
    if (groups.length < 2) return;
    const owner = cards.find(({ members }) => members.some(m => m.id === selected[0]))!.owner.id;
    const members = new Set(groups.flatMap(({ members }) => members.map(m => m.id)));
    commit(masks.map(m => members.has(m.id) ? { ...m, group: owner } : m));
  };
  const separate = () => {
    const members = new Set(selectedGroups().flatMap(({ members }) => members.map(m => m.id)));
    commit(masks.map(m => {
      if (!members.has(m.id)) return m;
      const { group: _, ...rest } = m;
      return rest as Mask;
    }));
  };
  const canJoin = selectedGroups().length >= 2;
  const canSeparate = selectedGroups().some(({ members }) => members.length > 1);

  // Dragging a mask moves it, with the rest of the selection, whichever tool
  // is on; dragging a handle resizes it. Shift-click adds or drops a mask.
  const beginEdit = (e: PointerEvent<Element>, id: string, mode: "move" | Handle) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && mode === "move") {
      setSelected(current => current.includes(id) ? current.filter(other => other !== id) : [...current, id]);
      return;
    }
    frame.current!.setPointerCapture(e.pointerId);
    const ids = mode === "move" && selected.includes(id) ? selected : [id];
    setSelected(ids);
    // Without Shift on a touch screen, a tap with the Select tool adds or drops the mask.
    const toggle = mode === "move" && tool === "select" && e.pointerType !== "mouse" ? { id, selection: selected } : undefined;
    gesture.current = { kind: "edit", pointerId: e.pointerId, ids, start: point(e), before: masks, mode, toggle };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    setSelected([]);
    if (tool === "select") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { kind: "draw", pointerId: e.pointerId, id: crypto.randomUUID(), points: [point(e)] };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const p = point(e);
    if (g.kind === "draw") {
      g.points = tool === "freehand" ? [...g.points.slice(0, 4094), p] : [g.points[0], p];
      setDraft(drawMask(tool === "select" ? "rectangle" : tool, g.points, g.id));
      return;
    }
    const mode = g.mode;
    let dx = p.x - g.start.x, dy = p.y - g.start.y;
    const moving = g.before.filter(m => g.ids.includes(m.id));
    if (mode === "move") {
      // Masks moved together stop together at the image's edge.
      const boxes = moving.map(maskBounds);
      dx = Math.max(-Math.min(...boxes.map(b => b.x)), Math.min(1 - Math.max(...boxes.map(b => b.x + b.width)), dx));
      dy = Math.max(-Math.min(...boxes.map(b => b.y)), Math.min(1 - Math.max(...boxes.map(b => b.y + b.height)), dy));
    }
    setMasks(g.before.map(m => {
      if (!g.ids.includes(m.id)) return m;
      const box = maskBounds(m);
      return withBounds(m, mode === "move" ? moveBox(box, dx, dy) : resizeBox(box, mode, dx, dy, MIN_SIZE));
    }));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === "draw") {
      setDraft(undefined);
      const shape = tool === "select" ? "rectangle" : tool;
      const mask = drawMask(shape, shape === "freehand" ? [...g.points, point(e)] : [g.points[0], point(e)], g.id);
      const { width, height } = maskBounds(mask);
      if (width >= MIN_SIZE && height >= MIN_SIZE && validMasks([mask]).length) {
        commit([...masks, mask]);
        setSelected([mask.id]);
      }
      return;
    }
    // Only a mask that moved is an undo step; a click just selects it.
    if (masks.some((m, i) => m !== g.before[i])) commit(masks, g.before);
    else if (g.toggle) {
      const { id, selection } = g.toggle;
      setSelected(selection.includes(id) ? selection.filter(other => other !== id) : [...selection, id]);
    }
  };

  const onPointerCancel = () => {
    const g = gesture.current;
    gesture.current = null;
    setDraft(undefined);
    if (g?.kind === "edit") setMasks(g.before);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod || e.altKey) return;
    const choice = TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase());
    if (choice) { e.preventDefault(); setTool(choice.tool); return; }
    if ((e.key === "Backspace" || e.key === "Delete") && selected.length) { e.preventDefault(); remove(); return; }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow && selected.length) {
      e.preventDefault();
      const step = e.shiftKey ? NUDGE * 10 : NUDGE;
      commit(masks.map(m => selected.includes(m.id) ? withBounds(m, moveBox(maskBounds(m), arrow[0] * step, arrow[1] * step)) : m));
    }
  };

  const box = target && maskBounds(target);
  const area = box && { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` };

  return <Dialog open onOpenChange={(open, details) => {
    if (open) return;
    if (details.reason === "outside-press") { details.cancel(); return; }
    if (details.reason === "escape-key" && selected.length) {
      details.cancel();
      setSelected([]);
    } else onCancel();
  }}>
    <DialogContent ref={dialog} className="occlusion-dialog block sm:max-w-none" showCloseButton={false} onKeyDown={onKeyDown}>
    <DialogTitle>Image occlusion</DialogTitle>
    <p>Drag over the parts to hide. Each number is one card: Shift-click masks (or tap them with the Select tool) and join them to ask them together. Drag a mask to move it, or its handles to resize it.</p>
    <div className="occlusion-toolbar">
      <div className="flex items-center gap-0.5" role="toolbar" aria-label="Mask tools">
        {TOOLS.map(({ tool: t, label, key, Icon }) => (
            <IconTooltip key={t} label={label} hint={key} container={dialog}><Button size="icon-sm" variant={tool === t ? "secondary" : "ghost"} aria-label={label} aria-pressed={tool === t} onClick={() => setTool(t)}>
              <Icon />
            </Button></IconTooltip>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        <span className="mr-2 text-xs text-muted-foreground tabular-nums">{cards.length} {cards.length === 1 ? "card" : "cards"}</span>
          <Button size="sm" variant="ghost" title="Ask the selected masks as one card" disabled={!canJoin} onClick={join}><Combine />Join</Button>
          <Button size="sm" variant="ghost" title="Make each selected mask its own card" disabled={!canSeparate} onClick={separate}><Split />Separate</Button>
          <IconTooltip label="Undo" hint={formatKeys(action("history.undo").keys)} container={dialog}><Button size="icon-sm" variant="ghost" aria-label="Undo" disabled={!history.length} onClick={undo}><Undo2 /></Button></IconTooltip>

          <IconTooltip label="Delete mask" hint="Backspace / Delete" container={dialog}><Button size="icon-sm" variant="ghost" aria-label="Delete mask" disabled={!selected.length} onClick={remove}><Trash2 /></Button></IconTooltip>

      </div>
    </div>
    <div
      ref={frame}
      className={cn("occlusion-frame", tool !== "select" && "cursor-crosshair")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <img src={src} alt="Image to mask" draggable={false} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Occlusion masks">
        {[...masks, ...(draft ? [draft] : [])].map((m, i) => (
          <MaskShape
            key={m.id}
            mask={m}
            className={cn("occlusion-mask", selected.includes(m.id) && "is-selected")}
            vectorEffect="non-scaling-stroke"
            onPointerDown={e => { if (e.button === 0 && m !== draft) beginEdit(e, m.id, "move"); }}
          >
            <title>Mask {i + 1}</title>
          </MaskShape>
        ))}
      </svg>
      {masks.map(m => {
        const b = maskBounds(m);
        return <span key={m.id} className={cn("occlusion-number", selected.includes(m.id) && "is-selected")} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%` }} aria-hidden>{cardNumber.get(m.id)}</span>;
      })}
      {area && target && (
        <div className="occlusion-selection" style={area} onPointerDown={e => { if (e.button === 0) beginEdit(e, target.id, "move"); }}>
          {HANDLES.map(handle => (
            <span
              key={handle}
              className={`image-crop-handle image-crop-handle-${handle}`}
              aria-hidden
              onPointerDown={e => { if (e.button === 0) beginEdit(e, target.id, handle); }}
            />
          ))}
        </div>
      )}
    </div>
    <div className="flex justify-end gap-2 mt-4">
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button onClick={() => onSave(masks)}>Save masks</Button>
    </div>
    </DialogContent>
  </Dialog>;
}
