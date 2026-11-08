import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripVertical } from "lucide-react";

const noteName = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");
const folderName = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Root folder";
// Match the center of the 20px first line, including wrapping formatting labels.
export const importCheckboxClass = "mt-0.5 size-4 shrink-0";
type Drag = { path: string; from: number; to: number; y: number; startY: number; scrollTop: number; tops: number[]; heights: number[]; pointerId: number; active: boolean };

export function ImportNoteList({ order, excluded, disabled, onReorder, onInclude }: {
  order: string[]; excluded: string[]; disabled: boolean;
  onReorder: (order: string[]) => void; onInclude: (path: string, included: boolean) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<Drag | null>(null);
  const [picked, setPicked] = useState<{ path: string; original: string[] } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dragging = !!preview;
  const announce = (path: string, position: number, action: string) => setAnnouncement(`${action} ${noteName(path)}. Position ${position + 1} of ${order.length}.`);
  useEffect(() => () => { drag.current = null; }, []);
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      drag.current = null; setPreview(null); setAnnouncement("Cancelled moving note.");
    };
    window.addEventListener("keydown", cancel, true);
    let frame: number;
    const tick = () => {
      const current = drag.current;
      const el = list.current;
      if (!current || !el) return;
      if (current.active) {
        const bounds = el.getBoundingClientRect();
        const speed = current.y < bounds.top + 36 ? -Math.min(10, (bounds.top + 36 - current.y) / 4)
          : current.y > bounds.bottom - 36 ? Math.min(10, (current.y - bounds.bottom + 36) / 4) : 0;
        el.scrollTop += speed;
        const center = current.tops[current.from] + current.heights[current.from] / 2 + current.y - current.startY + el.scrollTop - current.scrollTop;
        current.to = current.tops.reduce((target, top, i) => center >= top + current.heights[i] / 2 ? i : target, 0);
        setPreview({ ...current });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", cancel, true); };
  }, [dragging]);
  function start(event: PointerEvent<HTMLDivElement>, path: string, from: number) {
    if (disabled || picked || event.button !== 0 || (event.target as HTMLElement).closest("input")) return;
    event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
    const el = list.current!;
    const rows = [...el.children] as HTMLElement[];
    drag.current = { path, from, to: from, y: event.clientY, startY: event.clientY, scrollTop: el.scrollTop, tops: rows.map(row => row.offsetTop), heights: rows.map(row => row.offsetHeight), pointerId: event.pointerId, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview({ ...drag.current });
  }
  function finish(cancel: boolean) {
    const current = drag.current;
    if (!current) return;
    if (!cancel && current.active) {
      const next = [...order]; next.splice(current.from, 1); next.splice(current.to, 0, current.path);
      onReorder(next); announce(current.path, current.to, "Dropped");
    }
    drag.current = null; setPreview(null);
  }
  const scrollAfterReorder = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!scrollAfterReorder.current) return;
    const index = order.indexOf(scrollAfterReorder.current);
    scrollAfterReorder.current = null;
    list.current?.querySelector<HTMLButtonElement>(`[data-handle-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [order]);
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, path: string, index: number) {
    if (event.key === "Escape" && (picked || drag.current)) {
      event.preventDefault(); event.stopPropagation();
      if (picked) { onReorder(picked.original); setPicked(null); setAnnouncement(`Cancelled moving ${noteName(path)}.`); }
      finish(true); return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (picked) { setPicked(null); announce(path, index, "Dropped"); }
      else { setPicked({ path, original: [...order] }); announce(path, index, "Picked up"); }
    } else if ((picked || event.altKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const to = Math.max(0, Math.min(order.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      const next = [...order]; next.splice(index, 1); next.splice(to, 0, path); onReorder(next);
      announce(path, to, "Moved");
      scrollAfterReorder.current = path;
    }
  }
  return <>
    <p id="import-sort-help" className="shrink-0 text-muted-foreground">Drag to reorder, including between folders. Uncheck notes to leave them out.</p>
    <p id="import-sort-keys" className="sr-only">Focus a drag handle and press Space to pick up. Use arrow keys to move, Space or Enter to drop, or Escape to cancel.</p>
    <ol ref={list} aria-label="Notes to import" aria-describedby="import-sort-help import-sort-keys" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {order.map((path, index) => {
        const active = preview?.active && preview.path === path;
        let offset = 0;
        if (preview?.active) {
          if (active) offset = preview.y - preview.startY + (list.current?.scrollTop ?? 0) - preview.scrollTop;
          else if (index > preview.from && index <= preview.to) offset = -preview.heights[preview.from];
          else if (index < preview.from && index >= preview.to) offset = preview.heights[preview.from];
        }
        return <li key={path} className={`relative ${active ? "z-10" : "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-in-out"}`} style={{ transform: `translateY(${offset}px)` }}>
          {(index === 0 || folderName(path) !== folderName(order[index - 1])) && <p className="h-7 truncate pt-2 text-xs font-medium text-muted-foreground" title={folderName(path)}>{folderName(path)}</p>}
          <div className={`relative flex h-9 touch-none select-none items-center gap-2 rounded-md border-b px-1 ${active || picked?.path === path ? "bg-muted shadow-sm" : "bg-popover"} ${excluded.includes(path) ? "text-muted-foreground bg-muted/40" : ""} ${disabled ? "" : "cursor-grab active:cursor-grabbing"}`}
            onPointerDown={event => start(event, path, index)}
            onPointerMove={event => { const current = drag.current; if (current?.pointerId === event.pointerId) { current.y = event.clientY; if (Math.abs(current.y - current.startY) > 4) current.active = true; } }}
            onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
            onKeyDown={event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); } }}>
            <button type="button" disabled={disabled} aria-label={`Reorder ${noteName(path)}`} aria-describedby="import-sort-keys" aria-pressed={picked?.path === path} data-handle-index={index} className="flex h-8 w-6 shrink-0 items-center justify-center rounded text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring" onKeyDown={event => keyboard(event, path, index)}><GripVertical className="size-4" /></button>
            <label className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,1fr)] gap-2 leading-5" onClick={event => { if (preview?.active) event.preventDefault(); }}>
              <input type="checkbox" className={importCheckboxClass} disabled={disabled} checked={!excluded.includes(path)} onChange={event => onInclude(path, event.target.checked)} />
              <span className="truncate" title={path}>{noteName(path)}</span>
            </label>
            {preview?.active && preview.to === index && !active && <span aria-hidden="true" className={`pointer-events-none absolute inset-x-0 h-0.5 bg-ring ${preview.to > preview.from ? "bottom-0" : "top-0"}`} />}
          </div>
        </li>;
      })}
    </ol>
    <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
  </>;
}
