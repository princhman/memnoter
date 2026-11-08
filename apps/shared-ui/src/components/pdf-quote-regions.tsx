import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { PdfQuoteRegion } from "@/lib/use-pdf-quote-regions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

const regionKey = (region: PdfQuoteRegion) => `${region.x},${region.y},${region.width},${region.height}`;

/** Visuals pass through to PDF text; only the small corner controls take pointer input. */
export const PdfQuoteRegions = memo(function PdfQuoteRegions({ regions, onNavigate, disabled = false }: {
  regions: readonly PdfQuoteRegion[] | undefined;
  onNavigate?: (quoteId: string) => void;
  disabled?: boolean;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const navigating = useRef(false);
  const [open, setOpen] = useState<string | null>(null);
  const activate = useCallback((region: PdfQuoteRegion) => {
    if (disabled || !onNavigate) return;
    const [first] = region.uses;
    if (region.uses.length > 1) { navigating.current = false; setOpen(regionKey(region)); }
    else if (first) onNavigate(first.quoteId);
  }, [disabled, onNavigate]);
  useEffect(() => {
    if (disabled) setOpen(null);
    const page = overlay.current?.parentElement;
    if (!page || disabled || !onNavigate) return;
    let start: { x: number; y: number; id: number; dragged: boolean } | null = null;
    const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest("a,button,input,select,textarea,[role=button],[role=menuitem]");
    const down = (event: PointerEvent) => {
      start = event.isPrimary && event.button === 0 && !interactive(event.target)
        ? { x: event.clientX, y: event.clientY, id: event.pointerId, dragged: false } : null;
    };
    const move = (event: PointerEvent) => {
      if (start && (event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)) start.dragged = true;
    };
    const cancel = () => { start = null; };
    const click = (event: MouseEvent) => {
      const gesture = start;
      start = null;
      if (!gesture || gesture.dragged || event.defaultPrevented || interactive(event.target) || !window.getSelection()?.isCollapsed || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) return;
      const bounds = page.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
      const region = regions?.find(region => region.uses.length && x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height);
      if (region) activate(region);
    };
    page.addEventListener("pointerdown", down);
    page.addEventListener("pointermove", move);
    page.addEventListener("pointercancel", cancel);
    page.addEventListener("click", click);
    return () => {
      page.removeEventListener("pointerdown", down);
      page.removeEventListener("pointermove", move);
      page.removeEventListener("pointercancel", cancel);
      page.removeEventListener("click", click);
    };
  }, [regions, disabled, onNavigate, activate]);
  if (!regions?.length) return null;
  return <div ref={overlay} className="pointer-events-none absolute inset-0">
    {regions.map(region => {
      const key = regionKey(region);
      const label = `Show quote in note${region.uses.length > 1 ? ` (${region.uses.length} uses)` : ""}`;
      const control = "pointer-events-auto absolute right-0 top-0 flex size-6 items-center justify-center rounded-sm bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
      return <div key={key} className="pointer-events-none absolute border border-primary/80 bg-primary/5"
        style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}>
        {!disabled && onNavigate && region.uses.length > 0 && (region.uses.length === 1
          ? <button type="button" className={control} aria-label={label} title={label} onClick={() => activate(region)}><ArrowUpRight aria-hidden="true" className="size-4" /></button>
          : <DropdownMenu open={open === key} onOpenChange={value => { if (value) navigating.current = false; setOpen(value ? key : null); }}>
            <DropdownMenuTrigger className={control} aria-label={label} title={label}><ArrowUpRight aria-hidden="true" className="size-4" /></DropdownMenuTrigger>
            <DropdownMenuContent className="max-w-72" finalFocus={() => !navigating.current}>
              {region.uses.map(use => <DropdownMenuItem key={use.quoteId} onClick={() => { navigating.current = true; setOpen(null); onNavigate(use.quoteId); }}>{use.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>)}
      </div>;
    })}
  </div>;
});
