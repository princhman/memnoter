import { useCallback, useEffect, useRef, useState } from "react";
import { normalizePdfRegion, type PdfRegion } from "@/lib/pdf-quote";

export function PdfRegionSelection({ onSelect, onCancel }: { onSelect: (region: PdfRegion) => void; onCancel: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; pointer: number; width: number; height: number } | null>(null);
  const [region, setRegion] = useState<PdfRegion | null>(null);
  const release = useCallback((element: HTMLDivElement | null) => {
    const down = start.current;
    start.current = null;
    if (down && element?.hasPointerCapture(down.pointer)) element.releasePointerCapture(down.pointer);
  }, []);
  const reset = useCallback(() => { release(host.current); setRegion(null); }, [release]);
  useEffect(() => {
    const element = host.current;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); reset(); onCancel();
    };
    // Page layout can change independently of zoom (for example on rotation).
    // A drag must never combine coordinates from two different page sizes.
    const observer = new ResizeObserver(() => {
      const down = start.current;
      const rect = element?.getBoundingClientRect();
      if (down && rect && (rect.width !== down.width || rect.height !== down.height)) reset();
    });
    if (element) observer.observe(element);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("keydown", cancel);
      observer.disconnect();
      release(element);
    };
  }, [onCancel, release, reset]);
  return <div ref={host} aria-label="Drag a region on this PDF page" className="absolute inset-0 z-10 touch-none cursor-crosshair select-none"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary || start.current) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      start.current = { x: event.clientX - rect.left, y: event.clientY - rect.top, pointer: event.pointerId, width: rect.width, height: rect.height };
      setRegion(null); event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      const down = start.current; if (!down || down.pointer !== event.pointerId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width !== down.width || rect.height !== down.height) { reset(); return; }
      setRegion(normalizePdfRegion(down, { x: event.clientX - rect.left, y: event.clientY - rect.top }, rect));
    }} onPointerUp={event => {
      const down = start.current; if (!down || down.pointer !== event.pointerId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const selected = rect.width === down.width && rect.height === down.height
        ? normalizePdfRegion(down, { x: event.clientX - rect.left, y: event.clientY - rect.top }, rect) : null;
      reset(); if (selected) onSelect(selected);
    }} onPointerCancel={event => { if (start.current?.pointer === event.pointerId) reset(); }}
    onLostPointerCapture={event => { if (start.current?.pointer === event.pointerId) reset(); }}>
    {region && <div className="pointer-events-none absolute border-2 border-primary bg-primary/15" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}
  </div>;
}
