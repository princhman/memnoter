import { MessageSquare, Highlighter } from "lucide-react";
import { pdfHighlightColors } from "./pdf-highlight-colors";
import { memo, useEffect, useRef } from "react";
import type { PdfAnnotation } from "@/lib/pdf-annotations";

/** Fill is pointer-transparent so native text selection still starts on a highlight. */
export const PdfAnnotationLayer = memo(function PdfAnnotationLayer({ annotations, pageNumber, disabled, onOpen }: {
  annotations: readonly PdfAnnotation[];
  pageNumber: number;
  disabled: boolean;
  onOpen: (id: string, bounds: DOMRect, page: number) => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const page = overlay.current?.parentElement;
    if (!page || disabled) return;
    let start: { x: number; y: number; id: number; dragged: boolean } | null = null;
    const down = (event: PointerEvent) => {
      start = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId, dragged: false } : null;
    };
    const move = (event: PointerEvent) => {
      if (start && (event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)) start.dragged = true;
    };
    const cancel = () => { start = null; };
    const click = (event: MouseEvent) => {
      const gesture = start; start = null;
      if (!gesture || gesture.dragged || !window.getSelection()?.isCollapsed || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) return;
      if (event.target instanceof Element && event.target.closest("button,a,input,textarea")) return;
      const bounds = page.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
      const annotation = annotations.find(annotation => annotation.anchors.some(anchor => anchor.page === pageNumber && anchor.regions.some(region => x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height)));
      if (annotation) {
        event.preventDefault(); event.stopImmediatePropagation();
        onOpen(annotation.id, new DOMRect(event.clientX, event.clientY, 0, 0), pageNumber);
      }
    };
    page.addEventListener("pointerdown", down, true);
    page.addEventListener("pointermove", move, true);
    page.addEventListener("pointercancel", cancel, true);
    // Capture runs before the quote-region navigation listener on this page.
    page.addEventListener("click", click, true);
    return () => {
      page.removeEventListener("pointerdown", down, true);
      page.removeEventListener("pointermove", move, true);
      page.removeEventListener("pointercancel", cancel, true);
      page.removeEventListener("click", click, true);
    };
  }, [annotations, pageNumber, disabled, onOpen]);
  return <div ref={overlay} data-pdf-annotations className="pointer-events-none absolute inset-0 z-[4]">
    {annotations.flatMap(annotation => annotation.anchors.filter(anchor => anchor.page === pageNumber).flatMap(anchor => anchor.regions.map((region, index) =>
      <div key={`${annotation.id}:${index}`} className="absolute rounded-[1px]" style={{ backgroundColor: `color-mix(in srgb, ${pdfHighlightColors[annotation.color].value} 30%, transparent)`, left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}>
        {index === 0 && !disabled && <button type="button" aria-label={annotation.body ? `Edit PDF comment: ${annotation.body}` : "Edit PDF highlight"} className="pointer-events-auto absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-sm bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-primary" onClick={event => { event.stopPropagation(); onOpen(annotation.id, event.currentTarget.getBoundingClientRect(), pageNumber); }}>{annotation.body ? <MessageSquare className="size-3" aria-hidden="true" /> : <Highlighter className="size-3" aria-hidden="true" />}</button>}
      </div>))) }
  </div>;
});
