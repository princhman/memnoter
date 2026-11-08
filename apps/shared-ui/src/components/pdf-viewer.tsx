import { usePdfQuoteRegions } from "@/lib/use-pdf-quote-regions";
import { PdfQuoteRegions } from "./pdf-quote-regions";
import { acceptsPdfShortcut, action, formatKeys, matchesShortcut } from "@/lib/shortcuts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { ArrowUpRight, ZoomIn, ZoomOut, PanelRight, SquareDashedMousePointer, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { documentPath, setDocumentPageCount, type DocumentRecord } from "@/lib/documents";
import { fileUrl } from "@/lib/backend";
import { parsePage, readPdfView, visiblePages } from "@/lib/pdf-state";
import { documentsKey } from "@/lib/use-documents";
import { requestSyncedFile } from "@/lib/sync/file-requests";
import { openPdfPane, pdfPageRequest } from "@/lib/pdf-pane";
import { registerCommand } from "@/lib/commands";
import { ToolButton } from "./ui/tool-button";
import { PdfRegionSelection } from "./pdf-region-selection";
import { cropPdfCanvas, type PdfRegion } from "@/lib/pdf-quote";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { useSelector } from "@tanstack/react-store";
import { Button } from "./ui/button";
GlobalWorkerOptions.workerSrc = workerUrl;

const PAGE_GAP = 16;
type ZoomAnchor = { page: number; x: number; y: number; clientX: number; clientY: number };
const clampZoom = (value: number) => Math.max(0.25, Math.min(3, Math.round(value * 1e6) / 1e6));
type Size = { width: number; height: number };

// Memoized: scrolling re-renders the viewer, but a page only redraws when it
// arrives, the zoom changes, or it enters or leaves the render window.
const PdfPage = memo(function PdfPage({ page, pageNumber, width, height, zoom, active, selecting, quoteRegions, onSelect, onCancel }: { page?: PDFPageProxy; pageNumber: number; width: number; height: number; zoom: number; active: boolean; selecting: boolean; quoteRegions?: readonly PdfRegion[]; onSelect: (canvas: HTMLCanvasElement, region: PdfRegion, pageNumber: number) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState<{ page: PDFPageProxy; zoom: number } | null>(null);
  const live = active && !!page;
  useLayoutEffect(() => {
    const target = canvas.current;
    const layer = text.current;
    if (!live || !page || !target || !layer) return;
    let disposed = false;
    setReady(null); setError("");
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: zoom });
    target.width = Math.ceil(viewport.width * ratio);
    target.height = Math.ceil(viewport.height * ratio);
    const render = page.render({ canvas: target, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    const textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
    void Promise.all([render.promise, textLayer.render()]).then(() => { if (!disposed) setReady({ page, zoom }); }).catch(error => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; render.cancel(); textLayer.cancel(); layer.replaceChildren(); target.width = 0; target.height = 0; };
  }, [page, zoom, live]);
  return <div className="pdf-page relative shrink-0 bg-white shadow-sm" style={{ width, height, "--scale-factor": zoom, "--total-scale-factor": zoom * (page?.userUnit ?? 1) } as React.CSSProperties}>
    {live && <><canvas ref={canvas} className="absolute inset-0 size-full" /><div ref={text} className="textLayer" /></>}
    {live && <PdfQuoteRegions regions={quoteRegions} />}
    {live && ready && ready.page === page && ready.zoom === zoom && selecting && <PdfRegionSelection key={zoom} onCancel={onCancel} onSelect={region => { if (canvas.current) onSelect(canvas.current, region, pageNumber); }} />}
    {error && <p role="alert" className="relative bg-background p-2 text-sm text-destructive">{error}</p>}
  </div>;
});

// Full screen puts the tools in the app header; the pane gets one slim row,
// with the pane's own controls on either side of them.
function ReaderTools({ children, fullscreen, leading, trailing }: { children: ReactNode; fullscreen: boolean; leading?: ReactNode; trailing?: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { if (fullscreen) setTarget(document.getElementById("pdf-toolbar")); }, [fullscreen]);
  if (fullscreen) return target && createPortal(children, target);
  return <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-background px-1.5">
    <div className="flex min-w-0 flex-1 items-center gap-1">{leading}</div>{children}{trailing}
  </div>;
}

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

export function PdfViewer({ doc, fullscreen = false, leading, trailing, initialPage }: { doc: DocumentRecord; fullscreen?: boolean; leading?: ReactNode; trailing?: ReactNode; initialPage?: number }) {
  const client = useQueryClient();
  const quoteRegions = usePdfQuoteRegions(doc.moduleId, doc.id);
  const root = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const pending = useSelector(pendingPdfQuote, state => state);
  const cropBusy = useRef(false);
  const cancelSelection = useCallback(() => setSelecting(false), []);
  useEffect(() => {
    if (!selecting) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") cancelSelection(); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [selecting, cancelSelection]);
  const selectRegion = useCallback(async (canvas: HTMLCanvasElement, region: PdfRegion, page: number) => {
    if (cropBusy.current || pendingPdfQuote.state) return;
    cropBusy.current = true; setCropping(true); setQuoteError(""); setSelecting(false);
    try {
      const blob = await cropPdfCanvas(canvas, region);
      if (pendingPdfQuote.state) throw new Error("Another quote is waiting. Finish it, then select this region again.");
      pendingPdfQuote.setState(previous => previous ?? ({ moduleId: doc.moduleId, file: new File([blob], `${doc.name}, page ${page}.png`, { type: "image/png" }),
        source: { documentId: doc.id, name: doc.name, page, region }, section: false, status: "draft" }));
    } catch (error) { setQuoteError(error instanceof Error ? error.message : String(error)); setSelecting(!pendingPdfQuote.state); }
    finally { cropBusy.current = false; setCropping(false); }
  }, [doc.id, doc.moduleId, doc.name]);
  const navigate = useNavigate();
  const [saved] = useState(() => ({ ...readPdfView(doc.id), ...(initialPage ? { page: initialPage } : {}) }));
  const [zoom, setZoom] = useState(saved.zoom);
  const [pinching, setPinching] = useState(false);
  const zoomValue = useRef(zoom);
  zoomValue.current = zoom;
  const content = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<ZoomAnchor | null>(null);
  const finishPinch = useRef<(() => number) | null>(null);
  const [current, setCurrent] = useState(saved.page);
  const [input, setInput] = useState(String(saved.page));
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  // Pages load as they come into view; until then they take page one's size.
  const [pages, setPages] = useState<(PDFPageProxy | undefined)[]>([]);
  const [base, setBase] = useState<Size>({ width: 612, height: 792 });
  const [active, setActive] = useState<number[]>([]);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const requested = useRef(new Set<number>());
  const frame = useRef(0);
  const shownPage = useRef(saved.page);

  useEffect(() => {
    if (!doc.available) { requestSyncedFile(doc.id); return; }
    let disposed = false;
    let loading: ReturnType<typeof getDocument> | undefined;
    void (async () => {
      const url = fileUrl(await documentPath({ id: doc.id }));
      if (disposed) return;
      const asset = (folder: string) => new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, document.baseURI).href;
      loading = getDocument({ url, cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
      const loaded = await loading.promise;
      const first = await loaded.getPage(1);
      if (disposed) return;
      const viewport = first.getViewport({ scale: 1 });
      requested.current = new Set([0]);
      setBase({ width: viewport.width, height: viewport.height });
      setPages(Array.from({ length: loaded.numPages }, (_, index) => index === 0 ? first : undefined));
      setPdf(loaded);
      if (doc.pageCount === null) {
        await setDocumentPageCount({ id: doc.id, pageCount: loaded.numPages });
        void client.invalidateQueries({ queryKey: documentsKey });
      }
    })().catch(error => { if (!disposed) setError(error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; void loading?.destroy(); };
    // Not keyed on pageCount: saving it must not reload the document.
  }, [doc.id, doc.available, client]);

  // Fetch the pages about to be drawn.
  useEffect(() => {
    if (!pdf) return;
    for (const index of active) {
      if (requested.current.has(index)) continue;
      requested.current.add(index);
      void pdf.getPage(index + 1).then(page => setPages(previous => {
        const next = previous.slice();
        next[index] = page;
        return next;
      })).catch(() => requested.current.delete(index));
    }
  }, [pdf, active]);

  const sizes = useMemo(() => pages.map(page => {
    if (!page) return { width: base.width * zoom, height: base.height * zoom };
    const viewport = page.getViewport({ scale: zoom });
    return { width: viewport.width, height: viewport.height };
  }), [pages, zoom, base]);
  const heights = useMemo(() => sizes.map(size => size.height + PAGE_GAP), [sizes]);
  const latestHeights = useRef(heights);
  latestHeights.current = heights;

  // Reads the scroll position at most once a frame, and only sets state when
  // the render window or the page number actually changes.
  function measure() {
    const element = container.current;
    if (!element) return;
    const rows = latestHeights.current;
    const next = visiblePages(rows, element.scrollTop, element.clientHeight);
    setActive(previous => sameList(previous, next) ? previous : next);
    let offset = 0; let page = 1;
    for (let i = 0; i < rows.length; i++) { if (offset > element.scrollTop + 1) break; page = i + 1; offset += rows[i]; }
    if (shownPage.current !== page) {
      shownPage.current = page;
      setCurrent(page);
      setInput(String(page));
    }
  }
  function scheduleMeasure() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; measure(); });
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function jump(page: number) {
    const element = container.current;
    if (!element) return;
    element.scrollTop = latestHeights.current.slice(0, page - 1).reduce((sum, value) => sum + value, 0);
    measure();
  }
  useLayoutEffect(() => {
    if (pages.length && !restored.current) { restored.current = true; jump(Math.min(saved.page, pages.length)); }
    const element = container.current;
    if (!element) return;
    measure();
    const observer = new ResizeObserver(scheduleMeasure); observer.observe(element);
    return () => observer.disconnect();
    // Re-measure when the layout changes size, not on every page arrival.
  }, [pages.length, zoom]);
  useEffect(() => {
    try { localStorage.setItem(`pdf-view:${doc.id}`, JSON.stringify({ page: current, zoom })); } catch { /* Storage may be unavailable. */ }
  }, [doc.id, current, zoom]);
  function anchorAt(clientX?: number, clientY?: number): ZoomAnchor | null {
    const element = container.current;
    if (!element || !content.current) return null;
    const viewport = element.getBoundingClientRect();
    const x = clientX ?? viewport.left + element.clientWidth / 2;
    const y = clientY ?? viewport.top + element.clientHeight / 2;
    const pageElements = Array.from(content.current.children);
    const page = pageElements.findIndex(element => element.getBoundingClientRect().bottom >= y);
    const index = page < 0 ? pageElements.length - 1 : page;
    const bounds = pageElements[index]?.getBoundingClientRect();
    return bounds ? { page: index, x: (x - bounds.left) / bounds.width, y: (y - bounds.top) / bounds.height, clientX: x, clientY: y } : null;
  }
  function clearPreview() {
    if (content.current) { content.current.style.transform = ""; content.current.style.transformOrigin = ""; content.current.style.pointerEvents = ""; }
  }
  useLayoutEffect(() => {
    clearPreview();
    const anchor = zoomAnchor.current;
    const element = container.current;
    const page = anchor && content.current?.children[anchor.page];
    if (element && anchor && page) {
      const bounds = page.getBoundingClientRect();
      element.scrollLeft += bounds.left + bounds.width * anchor.x - anchor.clientX;
      element.scrollTop += bounds.top + bounds.height * anchor.y - anchor.clientY;
      measure();
    }
    zoomAnchor.current = null;
  }, [zoom]);
  function changeZoom(next: number) {
    const value = clampZoom(next);
    if (value === zoomValue.current) return;
    clearPreview();
    zoomAnchor.current = anchorAt();
    setZoom(value);
  }
  // Wheel pinch is Chromium's desktop trackpad protocol; WebKit also emits
  // gesture events. Only this viewport cancels browser zoom, never ordinary scroll.
  const captureAnchor = useRef(anchorAt);
  captureAnchor.current = anchorAt;
  useEffect(() => {
    const element = container.current;
    const grid = content.current;
    if (!element || !grid) return;
    const viewportHeight = () => element.clientHeight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preview = zoomValue.current;
    let anchor: ZoomAnchor | null = null;
    let native = false;
    let nativeBase = preview;
    let ignoreWheelUntil = 0;
    function finish() {
      if (!anchor) return zoomValue.current;
      clearTimeout(timer);
      if (native) { native = false; ignoreWheelUntil = performance.now() + 250; }
      if (preview !== zoomValue.current) {
        zoomAnchor.current = anchor;
        setZoom(preview);
      } else clearPreview();
      anchor = null;
      setPinching(false);
      return preview;
    }
    finishPinch.current = finish;
    const show = (value: number, event: Event) => {
      if (!anchor) {
        const x = "clientX" in event && typeof event.clientX === "number" ? event.clientX : undefined;
        const y = "clientY" in event && typeof event.clientY === "number" ? event.clientY : undefined;
        anchor = captureAnchor.current(x, y);
        if (!anchor) return;
        setPinching(true);
        const bounds = grid.getBoundingClientRect();
        if (anchor) grid.style.transformOrigin = `${anchor.clientX - bounds.left}px ${anchor.clientY - bounds.top}px`;
        grid.style.pointerEvents = "none";
      }
      preview = clampZoom(value);
      grid.style.transform = `scale(${preview / zoomValue.current})`;
      clearTimeout(timer);
      // WebKit sends gestureend; the timer also recovers an interrupted stream.
      timer = setTimeout(finish, native ? 350 : 160);
    };
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (native || performance.now() < ignoreWheelUntil) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight() : 1);
      show((anchor ? preview : zoomValue.current) * Math.exp(-delta * 0.01), event);
    }
    function gesture(event: Event) {
      event.preventDefault();
      if (event.type === "gesturestart") {
        native = true;
        // Discard a leading wheel preview if WebKit sends both protocols.
        clearTimeout(timer); clearPreview(); anchor = null;
        nativeBase = zoomValue.current;
      }
      if ("scale" in event && typeof event.scale === "number" && Number.isFinite(event.scale) && event.scale > 0) show(nativeBase * event.scale, event);
      if (event.type === "gestureend") { native = false; ignoreWheelUntil = performance.now() + 250; finish(); }
    }
    element.addEventListener("wheel", wheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.addEventListener(type, gesture, { passive: false });
    return () => {
      clearTimeout(timer); finishPinch.current = null; clearPreview();
      element.removeEventListener("wheel", wheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.removeEventListener(type, gesture);
    };
  }, [doc.available, error]);
  const pageRequest = useSelector(pdfPageRequest, state => state);
  useEffect(() => {
    if (pageRequest?.id === doc.id && pages.length) { jump(Math.max(1, Math.min(pages.length, pageRequest.page))); pdfPageRequest.setState(() => null); }
  }, [pageRequest, doc.id, pages.length]);
  const toggleSelection = useCallback(() => {
    if (cropBusy.current || pendingPdfQuote.state || !pdf) return;
    setQuoteError(""); setSelecting(value => !value);
  }, [pdf]);
  const openBeside = useCallback(() => {
    const finalZoom = finishPinch.current?.() ?? zoomValue.current;
    try { localStorage.setItem(`pdf-view:${doc.id}`, JSON.stringify({ page: shownPage.current, zoom: finalZoom })); } catch { /* Storage may be unavailable. */ }
    openPdfPane(doc.moduleId, doc.id);
    void navigate({ to: "/$moduleId", params: { moduleId: doc.moduleId } }).catch(error => setQuoteError(String(error)));
  }, [doc.id, doc.moduleId, navigate]);
  const showCursorAction = useCallback(() => {
    void navigate({ to: "/$moduleId", params: { moduleId: doc.moduleId } }).catch(error => setQuoteError(String(error)));
  }, [doc.moduleId, navigate]);
  useEffect(() => {
    if (!pdf || pending || cropping) return;
    return registerCommand({ ...action("pdf.select-region"), keywords: ["pdf", "quote"], run: toggleSelection });
  }, [pdf, pending, cropping, toggleSelection]);
  useEffect(() => {
    if (!fullscreen) return;
    return registerCommand({ ...action("pdf.open-beside"), keywords: ["pdf", "note"], run: openBeside });
  }, [fullscreen, openBeside]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!acceptsPdfShortcut(event, [root.current, root.current?.closest('[data-pdf-note]') ?? null, fullscreen ? document.getElementById("pdf-toolbar") : null])) return;
      if (matchesShortcut(event, action("pdf.select-region").keys)) {
        if (!pdf || pending || cropping) return;
        event.preventDefault(); event.stopPropagation(); toggleSelection();
      } else if (fullscreen && matchesShortcut(event, action("pdf.open-beside").keys)) {
        event.preventDefault(); event.stopPropagation(); openBeside();
      } else if (fullscreen && pending?.moduleId === doc.moduleId && pending.status === "draft" && matchesShortcut(event, action("pdf.quote.insert").keys)) {
        event.preventDefault(); event.stopPropagation(); showCursorAction();
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [fullscreen, pdf, pending, cropping, doc.moduleId, toggleSelection, openBeside, showCursorAction]);
  useEffect(() => {
    if (!fullscreen || pending?.moduleId !== doc.moduleId || pending.status !== "draft") return;
    return registerCommand({ ...action("pdf.quote.insert"), keywords: ["pdf", "quote", "cursor"], run: showCursorAction });
  }, [fullscreen, pending?.moduleId, pending?.status, doc.moduleId, showCursorAction]);
  const activeSet = useMemo(() => new Set(active), [active]);

  // The backdrop matches the app header, so the page sits on one surface.
  return <div ref={root} className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
    <ReaderTools fullscreen={fullscreen} leading={leading} trailing={trailing}>
      <div className="flex items-center gap-1 text-xs tabular-nums"><input aria-label="Page number" className="w-9 rounded bg-transparent px-1 text-right focus:bg-accent focus:outline-none" value={input} onChange={event => setInput(event.target.value)} onBlur={() => setInput(String(current))} onKeyDown={event => {
        if (event.key !== "Enter") return;
        const page = parsePage(input, pages.length); if (page !== null) jump(page); else setInput(String(current));
      }} /><span className="whitespace-nowrap text-muted-foreground">/ {pages.length || doc.pageCount || "?"}</span></div>
      <ToolButton label={`Zoom out (${Math.round(zoom * 100)}%)`} disabled={zoom <= 0.25} onClick={() => changeZoom((finishPinch.current?.() ?? zoom) - 0.1)}><ZoomOut /></ToolButton>
      <span className="min-w-8 text-center text-[11px] tabular-nums text-muted-foreground" aria-label="Zoom level">{Math.round(zoom * 100)}%</span>
      <ToolButton label={`Zoom in (${Math.round(zoom * 100)}%)`} disabled={zoom >= 3} onClick={() => changeZoom((finishPinch.current?.() ?? zoom) + 0.1)}><ZoomIn /></ToolButton>
      <ToolButton hint={formatKeys(action("pdf.select-region").keys)} label="Select region" pressed={selecting} disabled={!!pending || cropping || !pdf} onClick={toggleSelection}><SquareDashedMousePointer /></ToolButton>
      {fullscreen && <ToolButton label="Open beside note" hint={formatKeys(action("pdf.open-beside").keys)} onClick={openBeside}>
        {/* The small arrow says this moves the PDF into the note's side panel. */}
        <span className="relative"><PanelRight /><ArrowUpRight strokeWidth={3} className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-background" /></span>
      </ToolButton>}
    </ReaderTools>
    {(selecting || cropping || quoteError || (fullscreen && pending?.moduleId === doc.moduleId)) && <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex max-h-[calc(100%-1.5rem)] justify-center">
      <div className="pointer-events-auto flex min-w-0 max-w-sm flex-wrap items-center gap-2 overflow-y-auto rounded-lg floating-surface p-2 text-xs shadow-md [overflow-wrap:anywhere]" role="status">
        {selecting && !pending && <>Drag to select a quote<ToolButton label="Exit selection" onClick={cancelSelection}><X /></ToolButton></>}
        {cropping && "Preparing quote"}{quoteError && <span role="alert">{quoteError}</span>}
        {fullscreen && pending?.moduleId === doc.moduleId && <>{pending.status === "draft" ? "Quote ready" : pending.status === "saving" ? "Saving quote" : "Quote needs attention"}<Button size="xs" title={`Insert at cursor (${formatKeys(action("pdf.quote.insert").keys)})`} aria-keyshortcuts="Meta+Enter Control+Enter" disabled={pending.status !== "draft"} onClick={showCursorAction}>Insert at cursor</Button>{pending.status === "draft" && <Button size="xs" variant="ghost" onClick={() => pendingPdfQuote.setState(current => current === pending && current.status === "draft" ? null : current)}>Discard</Button>}</>}
      </div>
    </div>}
    {!doc.available ? <div className="m-auto grid gap-2 p-6 text-center text-sm text-muted-foreground"><p>Downloading from your other devices</p><p>{(doc.size / 1024 / 1024).toFixed(1)} MB</p></div> : error ? <p role="alert" className="m-auto p-4 text-sm text-destructive">{error}</p> : <div ref={container} className="min-h-0 flex-1 overflow-auto overscroll-contain" style={{ overflowAnchor: "none" }} onScroll={scheduleMeasure}>
      {!pages.length && <p className="p-8 text-center text-sm text-muted-foreground">Loading PDF</p>}
      <div ref={content} className="grid min-w-full w-max justify-items-center gap-4 pb-4">{sizes.map((size, index) => <PdfPage key={index} page={pages[index]} pageNumber={index + 1} width={size.width} height={size.height} zoom={zoom} active={activeSet.has(index)} quoteRegions={quoteRegions.get(index + 1)} selecting={selecting && !pending && !cropping && !pinching} onCancel={cancelSelection} onSelect={selectRegion} />)}</div>
    </div>}
  </div>;
}
