import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampZoom, FIT, zoomAround, type Point, type ImageBounds } from "@/lib/image-zoom";

export function ImagePreview({ src, alt }: { src?: string; alt: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const transform = useRef(FIT);
  const [zoom, setZoom] = useState(FIT);
  const tap = useRef<{ time: number; point: Point } | null>(null);
  const start = useRef<Point | null>(null);
  const moved = useRef(false);
  const bounds = (): ImageBounds => {
    const box = frame.current!;
    const img = image.current!;
    const fit = Math.min(box.clientWidth / (img.naturalWidth || 1), box.clientHeight / (img.naturalHeight || 1));
    return { width: box.clientWidth, height: box.clientHeight, imageWidth: img.naturalWidth * fit, imageHeight: img.naturalHeight * fit };
  };
  const update = (next: typeof FIT) => { transform.current = next; setZoom(next); };
  useEffect(() => {
    const observer = new ResizeObserver(() => update(clampZoom(transform.current, bounds())));
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const point = (event: ReactPointerEvent): Point => {
    const rect = frame.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const end = (event: ReactPointerEvent, cancelled = false) => {
    if (!pointers.current.has(event.pointerId)) return;
    const at = point(event);
    pointers.current.delete(event.pointerId);
    if (!cancelled && !moved.current && pointers.current.size === 0) {
      const previous = tap.current;
      if (previous && event.timeStamp - previous.time < 320 && Math.hypot(previous.point.x - at.x, previous.point.y - at.y) < 32) {
        update(transform.current.scale > 1 ? FIT : zoomAround(FIT, at, at, 2.5, bounds()));
        tap.current = null;
      } else tap.current = { time: event.timeStamp, point: at };
    } else tap.current = null;
  };
  return <div ref={frame} className="image-preview-viewport" style={{ overflow: "hidden", minHeight: 0, height: "100%", touchAction: "none", overscrollBehavior: "contain" }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const at = point(event);
      if (pointers.current.size === 0) { start.current = at; moved.current = false; }
      else { moved.current = true; tap.current = null; }
      pointers.current.set(event.pointerId, at);
    }}
    onPointerMove={event => {
      const old = pointers.current.get(event.pointerId);
      if (!old) return;
      event.preventDefault();
      event.stopPropagation();
      const at = point(event);
      if (start.current && Math.hypot(at.x - start.current.x, at.y - start.current.y) > 8) moved.current = true;
      const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const before = { x: (old.x + other.x) / 2, y: (old.y + other.y) / 2 };
        const after = { x: (at.x + other.x) / 2, y: (at.y + other.y) / 2 };
        const distance = Math.hypot(old.x - other.x, old.y - other.y);
        if (distance > 0) update(zoomAround(transform.current, before, after, transform.current.scale * Math.hypot(at.x - other.x, at.y - other.y) / distance, bounds()));
      } else if (transform.current.scale > 1) {
        update(clampZoom({ ...transform.current, x: transform.current.x + at.x - old.x, y: transform.current.y + at.y - old.y }, bounds()));
      }
      pointers.current.set(event.pointerId, at);
    }}
    onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)}>
    <img ref={image} src={src} alt={alt} draggable={false} onLoad={() => update(clampZoom(transform.current, bounds()))}
      className="h-full min-h-0 w-full object-contain" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, userSelect: "none", pointerEvents: "none" }} />
  </div>;
}
