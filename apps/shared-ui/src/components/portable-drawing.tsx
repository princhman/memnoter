import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { call } from "@/lib/backend";
import type { FileType } from "@/lib/content";
import { parseInk, paintInk, hitInk, inkCanvasSize, eraseInkPixels, insideLasso, lassoInk, translateInk, type InkPosition, type InkDocument, type InkStroke, type PaperStyle } from "@/lib/portable-ink";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Check, Ellipsis, Eraser, Highlighter, Lasso, Pencil, PenLine, Redo2, Undo2 } from "lucide-react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { DialogOverlay, DialogHeader, DialogFooter } from "./ui/dialog";
import { surfaceClass } from "./ui/surface";

const PENS = { pen: { label: "Pen", Icon: PenLine }, pencil: { label: "Pencil", Icon: Pencil }, marker: { label: "Marker", Icon: Highlighter } } as const;
const PAPER_STYLES = { blank: "Blank", lined: "Lined", grid: "Grid" } as const;
const COLORS = [
  { label: "Black", value: "#000000" },
  { label: "Blue", value: "#2455DA" },
  { label: "Red", value: "#D32F40" },
  { label: "Green", value: "#14804A" },
  { label: "Purple", value: "#713AC7" },
  { label: "Orange", value: "#DA7817" },
];
const toolButtonClass = "transition-none text-foreground active:bg-(--ghost-hover) active:opacity-75 aria-pressed:bg-primary/20 aria-expanded:aria-pressed:bg-primary/20";

function InkDot({ color, diameter, checked }: { color: string; diameter: number; checked?: boolean }) {
  const black = color === COLORS[0].value;
  return <span aria-hidden="true" className={`inline-flex items-center justify-center rounded-full text-white ${black ? "bg-black dark:bg-white dark:text-black" : ""}`}
    style={{ width: diameter, height: diameter, backgroundColor: black ? undefined : color }}>
    {checked && <Check className="size-3.5" />}
  </span>;
}

type Request = { moduleId: string; imageId: string; sourceId?: string | null; displayLabel?: string };
export type DrawingResult = { status: "save" | "cancel"; source?: FileType; preview?: FileType; width?: number; height?: number; expectedSourceId: string | null; asCopy: boolean; hasChanges: boolean };
const key = (r: Request) => `portable-ink:${JSON.stringify([r.moduleId, r.imageId])}`;
export function acknowledgePortableDrawing(r: Request) { localStorage.removeItem(key(r)); }
// Like the Mac editor: keep the page width, crop the height to the ink plus a
// 24pt margin (240pt when empty). The source keeps the whole paper.
function previewCanvas(doc: InkDocument) {
  const page = document.createElement("canvas");
  const { width, height } = inkCanvasSize(doc, 2);
  page.width = width; page.height = height;
  paintInk(page, { ...doc, paperStyle: "blank" });
  const scale = height / doc.height;
  const pixels = page.getContext("2d")!.getImageData(0, 0, width, height).data;
  const inked = (y: number) => { for (let i = y * width * 4, end = i + width * 4; i < end; i += 4) if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) return true; return false; };
  let first = 0; while (first < height && !inked(first)) first++;
  let last = height - 1; while (last > first && !inked(last)) last--;
  const pad = Math.round(24 * scale);
  const top = first >= height ? 0 : Math.max(0, first - pad);
  const bottom = first >= height ? Math.min(height, Math.round(240 * scale)) : Math.min(height, last + 1 + pad);
  const cropHeight = Math.max(1, bottom - top) / scale;
  const out = document.createElement("canvas");
  const size = inkCanvasSize({ width: doc.width, height: cropHeight }, 2);
  out.width = size.width;
  out.height = size.height;
  paintInk(out, doc, true, { top: top / scale, height: cropHeight });
  return out;
}
let active = false;
export async function openPortableDrawing(request: Request): Promise<DrawingResult> {
  if (active) throw new Error("Close the current drawing first.");
  active = true;
  try {
    const retained = localStorage.getItem(key(request));
    let initial: InkDocument = { version: 2, nativeData: "", paperStyle: "blank", width: 1024, height: 1440, portable: { version: 1, strokes: [] } };
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
  const [tool, setTool] = useState<InkStroke["tool"] | "eraser" | "lasso">("pen"), [color, setColor] = useState(COLORS[0].value), [width, setWidth] = useState(4), [touch, setTouch] = useState(false);
  const [pen, setPen] = useState<keyof typeof PENS>("pen");
  const [eraser, setEraser] = useState<"object" | "pixel">("object");
  const [eraserSize, setEraserSize] = useState(24);
  const [eraserMenuOpen, setEraserMenuOpen] = useState(false);
  const [selection, setSelection] = useState<{ indices: Set<number>; loop: InkPosition[] } | null>(null);
  const [lasso, setLasso] = useState<InkPosition[]>([]);
  const [penMenuOpen, setPenMenuOpen] = useState(false);
  const { Icon: PenIcon, label: penLabel } = PENS[pen];
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const requiresCopy = base !== (request.sourceId ?? null);
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
  const gesture = useRef<{
    id: number; before: InkDocument; stroke: InkStroke | null; last?: InkPosition;
    loop?: InkPosition[]; move?: NonNullable<typeof selection>; origin?: InkPosition;
  } | null>(null);
  const paint = useRef<() => void>(() => {});
  paint.current = () => {
    const c = canvas.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio;
    const size = inkCanvasSize(ink, rect.width * dpr / ink.width, rect.height * dpr / ink.height);
    if (c.width !== size.width) c.width = size.width;
    if (c.height !== size.height) c.height = size.height;
    paintInk(c, ink);
    const loop = lasso.length ? lasso : selection?.loop;
    const ctx = c.getContext("2d");
    if (!loop?.length || !ctx) return;
    const sx = rect.width / ink.width, sy = rect.height / ink.height;
    const accent = getComputedStyle(c).getPropertyValue("--primary").trim();
    ctx.save();
    ctx.scale(c.width / rect.width, c.height / rect.height);
    ctx.beginPath();
    ctx.moveTo(loop[0].x * sx, loop[0].y * sy);
    for (const p of loop.slice(1)) ctx.lineTo(p.x * sx, p.y * sy);
    if (!lasso.length) {
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = .12;
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.restore();
  };
  useEffect(() => { paint.current(); }, [ink, lasso, selection]);
  useEffect(() => {
    const resize = () => paint.current();
    const observer = new ResizeObserver(resize);
    if (canvas.current) observer.observe(canvas.current);
    let resolution: MediaQueryList;
    const monitorResolution = () => {
      resolution?.removeEventListener("change", monitorResolution);
      resolution = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener("change", monitorResolution);
      resize();
    };
    monitorResolution();
    return () => {
      observer.disconnect();
      resolution.removeEventListener("change", monitorResolution);
    };
  }, []);
  const checkpoint = (next: InkDocument) => {
    try { localStorage.setItem(key(request), JSON.stringify({ document: next, base })); setError(""); return true; }
    catch { setError("Local draft storage is full. Keep this window open and use Done to save."); return false; }
  };
  const update = (next: InkDocument) => { current.current = next; setInk(next); changed.current = true; checkpoint(next); };
  const clearSelection = () => { setSelection(null); setLasso([]); };
  const chooseTool = (next: typeof tool) => { clearSelection(); setTool(next); };
  const cancel = () => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setLasso([]);
    if (g.move) setSelection(g.move);
    if (current.current !== g.before) update(g.before);
  };
  const position = (e: PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(ink.width, (e.clientX - rect.left) * ink.width / rect.width)),
      y: Math.max(0, Math.min(ink.height, (e.clientY - rect.top) * ink.height / rect.height)),
    };
  };
  const sample = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || !canvas.current || e.pointerId !== g.id) return;
    const point = position(e);
    const { x, y } = point;
    const last = g.last ?? point;
    if (g.last && x === last.x && y === last.y && !g.stroke) return;
    g.last = point;
    const doc = current.current;
    const replace = (strokes: InkDocument["portable"]["strokes"]) =>
      update({ ...doc, portable: { ...doc.portable, strokes } });
    if (g.loop) {
      g.loop.push(point);
      setLasso([...g.loop]);
    } else if (g.move && g.origin) {
      const dx = x - g.origin.x, dy = y - g.origin.y;
      const { indices, loop } = g.move;
      if (!dx && !dy) {
        if (doc !== g.before) update(g.before);
        setSelection(g.move);
        return;
      }
      const strokes = g.before.portable.strokes.map((stroke, i) => indices.has(i) ? translateInk(stroke, dx, dy) : stroke);
      replace(strokes);
      setSelection({ indices, loop: loop.map(p => ({ x: p.x + dx, y: p.y + dy })) });
    } else if (g.stroke) {
      g.stroke.points.push({ x, y, pressure: e.pointerType === "mouse" ? .75 : Math.max(.05, e.pressure) });
      replace([...g.before.portable.strokes, g.stroke]);
    } else {
      const original = doc.portable.strokes;
      const strokes = eraser === "pixel"
        ? original.flatMap(stroke => eraseInkPixels(stroke, last, point, eraserSize / 2))
        : original.filter(stroke => !hitInk(stroke, x, y));
      if (eraser === "pixel" && strokes.length === original.length && strokes.every((stroke, i) => stroke === original[i])) return;
      if (eraser === "pixel" && (strokes.length > 20000 || strokes.reduce((count, stroke) => count + stroke.points.length, 0) > 500000
        || strokes.reduce((count, stroke) => count + ("kind" in stroke
          ? (stroke.mask?.length ?? 0) + (stroke.cuts?.reduce((sum, cut) => sum + cut.length, 0) ?? 0) : 0), 0) > 500000)) return;
      replace(strokes);
    }
  };
  const close = () => { cancel(); if (changed.current && !checkpoint(current.current)) return; finish({ status: "cancel", hasChanges: changed.current, expectedSourceId: base, asCopy: false }); };
  const discard = () => {
    acknowledgePortableDrawing(request);
    finish({ status: "cancel", hasChanges: false, expectedSourceId: base, asCopy: false });
  };
  const save = async (copy: boolean) => {
    if (gesture.current) return;
    setSaving(true); setError("");
    try {
      const doc = parseInk({ ...current.current, version: 2 });
      const source = await call<FileType>("save_file", { moduleId: request.moduleId, bytes: Array.from(new TextEncoder().encode(JSON.stringify(doc))), mimeType: "application/vnd.memnoter.drawing+json" });
      const png = await new Promise<Blob>((resolve, reject) => previewCanvas(doc).toBlob(b => b ? resolve(b) : reject(new Error("Preview failed")), "image/png"));
      const preview = await call<FileType>("save_file", { moduleId: request.moduleId, bytes: Array.from(new Uint8Array(await png.arrayBuffer())), mimeType: "image/png" });
      finish({ status: "save", source, preview, width: doc.width, height: doc.height, expectedSourceId: base, asCopy: copy && (request.sourceId != null || requiresCopy), hasChanges: changed.current });
    } catch (e) { setError(String(e)); setSaving(false); }
  };
  return <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Drawing editor" className="fixed inset-0 z-[100] flex flex-col bg-background text-foreground" onPointerDownCapture={e => {
    if (selection && e.target !== canvas.current && !gesture.current) clearSelection();
  }} onKeyDown={e => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest("[data-drawing-popup]")) return;
      if (e.key === "Tab") {
        const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
      if (saving) return;
      if (e.key === "Escape") {
        if (tool === "lasso" && (selection || gesture.current)) { cancel(); clearSelection(); }
        else close();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection && !gesture.current) {
        e.preventDefault();
        setUndo([...undo, ink]);
        setRedo([]);
        update({ ...ink, portable: { ...ink.portable, strokes: ink.portable.strokes.filter((_, i) => !selection.indices.has(i)) } });
        clearSelection();
      } }}>
    <header className="flex h-12 shrink-0 items-center gap-2 px-3">
      <Button variant="ghost" size="sm" disabled={saving} onClick={close}>Close</Button>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{request.displayLabel ? `Question ${request.displayLabel}` : "Drawing"}</span>
        {requiresCopy ? <span className="text-xs text-muted-foreground">This drawing changed elsewhere.</span>
          : recovered && <span className="text-xs text-muted-foreground">Recovered local draft</span>}
      </div>
      {requiresCopy && <Button variant="ghost" size="sm" className="text-destructive" disabled={saving} onClick={() => setConfirmingDiscard(true)}>Discard local changes</Button>}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />} aria-label="Drawing options" disabled={saving}>
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent container={dialog} align="end" className="w-max" data-drawing-popup>
          <Menu.CheckboxItem role="switch" aria-label="Touch drawing" checked={touch} onCheckedChange={setTouch} closeOnClick
            className="flex cursor-default items-center justify-between gap-3 rounded-md px-1.5 py-1 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground">
            Touch drawing
            <Menu.CheckboxItemIndicator><Check className="size-4" /></Menu.CheckboxItemIndicator>
          </Menu.CheckboxItem>
          <DropdownMenuRadioGroup aria-label="Paper style" value={ink.paperStyle}>
            <Menu.GroupLabel className="px-1.5 py-1 text-xs text-muted-foreground">Paper style</Menu.GroupLabel>
            {(Object.keys(PAPER_STYLES) as PaperStyle[]).map(style => (
              <DropdownMenuRadioItem key={style} value={style} onClick={() => {
                if (style === ink.paperStyle) return;
                setUndo([...undo, ink]); setRedo([]); update({ ...ink, paperStyle: style });
              }}>{PAPER_STYLES[style]}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuItem onClick={() => void save(true)}>Save a copy</DropdownMenuItem>
          {changed.current && <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDiscard(true)}>Discard local changes</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" disabled={saving} onClick={() => void save(requiresCopy)}>{requiresCopy ? "Save a copy" : "Done"}</Button>
    </header>
    <AlertDialog.Root open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
      <AlertDialog.Portal container={dialog}>
        <DialogOverlay />
        <AlertDialog.Popup data-drawing-popup className={`fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 ${surfaceClass} p-4 text-sm outline-none`}>
          <DialogHeader>
            <AlertDialog.Title className="text-base font-semibold">Discard local changes?</AlertDialog.Title>
            <AlertDialog.Description className="text-muted-foreground">This removes the local draft and returns to the note. The drawing saved in the note is kept.</AlertDialog.Description>
          </DialogHeader>
          <DialogFooter>
            <AlertDialog.Close render={<Button variant="ghost" />}>Cancel</AlertDialog.Close>
            <Button variant="destructive" onClick={discard}>Discard local changes</Button>
          </DialogFooter>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    <div className="relative flex-1 overflow-auto bg-muted p-4 pb-20">
      {error && <p role="alert" className={`sticky top-0 z-10 mx-auto mb-3 w-fit max-w-full ${surfaceClass} px-3 py-1.5 text-sm text-destructive`}>{error}</p>}
      <canvas ref={canvas} aria-label="Drawing paper" className="mx-auto block bg-white" style={{ width: "min(100%, 1024px)", aspectRatio: `${ink.width} / ${ink.height}`, height: "auto", touchAction: touch ? "none" : "pan-y" }}
        onPointerEnter={e => { if (e.pointerType === "pen") e.currentTarget.style.touchAction = "none"; }}
        onPointerDown={e => {
          if (saving || gesture.current || e.button !== 0 || (e.pointerType === "touch" && (!touch || !e.isPrimary || e.width > 30 || e.height > 30))) return;
          e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
          dialog.current?.focus({ preventScroll: true });
          const before = current.current;
          const g: NonNullable<typeof gesture.current> = {
            id: e.pointerId, before, stroke: tool === "eraser" || tool === "lasso" ? null : { tool, color, width, points: [] },
          };
          if (tool === "lasso") {
            const point = position(e.nativeEvent);
            if (selection && insideLasso(point, selection.loop)) {
              g.move = selection;
              g.origin = point;
            } else {
              clearSelection();
              g.loop = [];
            }
          }
          gesture.current = g;
          sample(e.nativeEvent);
        }}
        onPointerMove={e => { if (gesture.current?.id !== e.pointerId) return; const events = e.nativeEvent.getCoalescedEvents?.() ?? []; for (const event of events.length ? events : [e.nativeEvent]) sample(event); }}
        onPointerUp={e => {
          const g = gesture.current;
          if (!g || g.id !== e.pointerId) return;
          sample(e.nativeEvent);
          gesture.current = null;
          if (g.loop && g.loop.length >= 3) {
            const loop = g.loop;
            const indices = new Set<number>();
            g.before.portable.strokes.forEach((stroke, i) => { if (lassoInk(stroke, loop)) indices.add(i); });
            if (indices.size) setSelection({ indices, loop });
          }
          setLasso([]);
          if (current.current !== g.before) { setUndo([...undo, g.before]); setRedo([]); }
        }}
        onPointerCancel={e => { if (gesture.current?.id === e.pointerId) cancel(); }} onLostPointerCapture={e => { if (gesture.current?.id === e.pointerId) cancel(); }} />
      <Button className="mx-auto mt-3 block" variant="ghost" disabled={ink.height >= 8192 || saving} onClick={() => { setUndo([...undo, ink]); setRedo([]); update({ ...ink, height: ink.height + 1440 }); }}>Add paper</Button>
    </div>
    <div role="toolbar" aria-label="Ink" className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full floating-surface bg-popover/80 px-1.5 py-1 shadow-md backdrop-blur-md">
      <Button variant="ghost" size="icon-lg" className={toolButtonClass} aria-label="Undo" title="Undo" disabled={!undo.length || saving} onClick={() => { clearSelection(); const previous = undo[undo.length-1]; setRedo([...redo, ink]); setUndo(undo.slice(0,-1)); update(previous); }}><Undo2 /></Button>
      <Button variant="ghost" size="icon-lg" className={toolButtonClass} aria-label="Redo" title="Redo" disabled={!redo.length || saving} onClick={() => { clearSelection(); const next = redo[redo.length-1]; setUndo([...undo, ink]); setRedo(redo.slice(0,-1)); update(next); }}><Redo2 /></Button>
      <Popover.Root open={penMenuOpen} onOpenChange={open => {
        if (open && tool !== pen) chooseTool(pen);
        else setPenMenuOpen(open);
      }}>
        <Popover.Trigger render={<Button variant="ghost" size="icon-lg" className={toolButtonClass} />}
          aria-label={penLabel} title={penLabel} aria-pressed={tool === pen} disabled={saving}><PenIcon /></Popover.Trigger>
        <Popover.Portal container={dialog}>
          <Popover.Positioner side="top" sideOffset={8} className="z-20">
            <Popover.Popup aria-label="Pen variants" className={`${surfaceClass} min-w-32 p-1 outline-none`} data-drawing-popup>
              {(["pen", "pencil", "marker"] as const).map(variant => {
                const { label, Icon } = PENS[variant];
                return <Button key={variant} variant="ghost" size="sm" className="w-full justify-start" aria-pressed={pen === variant} onClick={() => {
                  setPen(variant);
                  chooseTool(variant);
                  setPenMenuOpen(false);
                }}>
                  <Icon />{label}{pen === variant && <Check aria-hidden="true" className="ml-auto" />}
                </Button>;
              })}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Popover.Root open={eraserMenuOpen} onOpenChange={open => {
        if (open && tool !== "eraser") chooseTool("eraser");
        else setEraserMenuOpen(open);
      }}>
        <Popover.Trigger render={<Button variant="ghost" size="icon-lg" className={toolButtonClass} />}
          aria-label="Eraser" title="Eraser" aria-pressed={tool === "eraser"} disabled={saving}><Eraser /></Popover.Trigger>
        <Popover.Portal container={dialog}>
          <Popover.Positioner side="top" sideOffset={8} className="z-20">
            <Popover.Popup aria-label="Eraser variants" className={`${surfaceClass} w-max p-1 outline-none`} data-drawing-popup>
              {(["object", "pixel"] as const).map(variant => (
                <Button key={variant} variant="ghost" size="sm" className="w-full justify-start" aria-pressed={eraser === variant} onClick={() => {
                  setEraser(variant);
                  setEraserMenuOpen(false);
                }}>
                  {variant === "object" ? "Object eraser" : "Pixel eraser"}
                  {eraser === variant && <Check aria-hidden="true" className="ml-auto" />}
                </Button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Button variant="ghost" size="icon-lg" className={toolButtonClass} aria-label="Lasso" title="Lasso"
        aria-pressed={tool === "lasso"} disabled={saving} onClick={() => chooseTool("lasso")}><Lasso /></Button>
      <Popover.Root>
        <Popover.Trigger render={<Button variant="ghost" size="icon-lg" className={toolButtonClass} />}
          aria-label="Colour and thickness" title="Colour and thickness" disabled={saving}>
          <InkDot color={color} diameter={Math.max(5, width * 1.4)} />
        </Popover.Trigger>
        <Popover.Portal container={dialog}>
          <Popover.Positioner side="top" sideOffset={8} className="z-20">
            <Popover.Popup className={`${surfaceClass} space-y-2 p-3 outline-none`} data-drawing-popup>
              {tool === "eraser" && eraser === "pixel" ? (
                <label className="flex min-w-40 flex-col gap-1 text-sm font-medium">
                  Eraser size
                  <input type="range" min={4} max={72} value={eraserSize} onChange={e => setEraserSize(e.currentTarget.valueAsNumber)} className="w-full accent-primary" />
                </label>
              ) : <>
                <Popover.Title className="text-sm font-medium">Ink colour</Popover.Title>
                <div className="flex gap-0.5">
                  {COLORS.map(option => <Button key={option.value} variant="ghost" size="icon-lg" className={toolButtonClass}
                    aria-label={option.label} title={option.label} aria-pressed={color === option.value} onClick={() => {
                      setColor(option.value);
                      if (tool !== pen) chooseTool(pen);
                    }}>
                    <InkDot color={option.value} diameter={26} checked={color === option.value} />
                  </Button>)}
                </div>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Stroke width
                  <input type="range" min={2} max={14} step={0.5} value={width} onChange={e => setWidth(e.currentTarget.valueAsNumber)} className="w-full accent-primary" />
                </label>
              </>}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  </div>;
}
