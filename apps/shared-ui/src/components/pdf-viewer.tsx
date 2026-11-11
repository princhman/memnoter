import { usePdfFind, PdfFindHighlights } from "./pdf-find";
import { pdfSelectionControls } from "@/lib/pdf-selection-controls";
import { usePdfAnnotations } from "@/lib/pdf-annotation-store";
import { parsePdfAnnotationColor, type PdfAnnotationColor, type PdfAnnotation, type PdfAnnotationAnchor } from "@/lib/pdf-annotations";
import { watchWriteAdmission } from "@/lib/write-lifecycle";
import { PdfAnnotationLayer } from "./pdf-annotation-layer";
import { PdfHighlightColors, pdfHighlightColors } from "./pdf-highlight-colors";
import { PdfAnnotationPopover } from "./pdf-annotation-popover";
import { usePdfQuoteNavigation } from "@/lib/pdf-quote-navigation";
import { usePdfQuoteRegions, type PdfQuoteRegion } from "@/lib/use-pdf-quote-regions";
import { PdfQuoteRegions } from "./pdf-quote-regions";
import { acceptsPdfShortcut, action, formatKeys, matchesShortcut } from "@/lib/shortcuts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { ArrowUpRight, ZoomIn, ZoomOut, PanelRight, SquareDashedMousePointer, Highlighter, MessageSquare, Quote, ChevronDown, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { documentPath, setDocumentPageCount, type DocumentRecord } from "@/lib/documents";
import { readNativePdf } from "@/lib/native-pdf";
import { fileUrl, isNativeHost, postNativeEvent } from "@/lib/backend";
import { parsePage, readPdfView, writePdfView, visiblePages } from "@/lib/pdf-state";
import { documentsKey } from "@/lib/use-documents";
import { requestSyncedFile } from "@/lib/sync/file-requests";
import { openPdfPane, pdfPageRequest } from "@/lib/pdf-pane";
import { registerCommand } from "@/lib/commands";
import { ToolButton } from "./ui/tool-button";
import { PdfRegionSelection } from "./pdf-region-selection";
import { cropPdfCanvas, type PdfRegion } from "@/lib/pdf-quote";
import { readPdfTextSelection } from "@/lib/pdf-text-selection";
import { pdfReaderControls, type PdfReaderActions } from "@/lib/pdf-reader-controls";
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
const PdfPage = memo(function PdfPage({ page, pageNumber, width, height, zoom, active, selecting, annotations, onAnnotationOpen, quoteRegions, quoteNavigationDisabled, onQuoteNavigate, onSelect, onCancel, find }: { find: ReturnType<typeof usePdfFind>; page?: PDFPageProxy; pageNumber: number; width: number; height: number; zoom: number; active: boolean; selecting: boolean; annotations: readonly PdfAnnotation[]; onAnnotationOpen: (id: string, bounds: DOMRect, page: number) => void; quoteRegions?: readonly PdfQuoteRegion[]; quoteNavigationDisabled: boolean; onQuoteNavigate: (quoteId: string) => void; onSelect: (canvas: HTMLCanvasElement, region: PdfRegion, pageNumber: number) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState<{ page: PDFPageProxy; zoom: number } | null>(null);
  const live = active && !!page;
  const findMatches = useMemo(() => find.matches.filter(match => match.page === pageNumber), [find.matches, pageNumber]);
  useLayoutEffect(() => {
    const target = canvas.current;
    const layer = text.current;
    if (!live || !page || !target || !layer) return;
    let disposed = false;
    setReady(null); setError("");
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: zoom });
    // Keep the displayed bitmap while PDF.js draws the new resolution. Resizing
    // the visible canvas here would clear it for one or more animation frames.
    const bitmap = document.createElement("canvas");
    bitmap.width = Math.ceil(viewport.width * ratio);
    bitmap.height = Math.ceil(viewport.height * ratio);
    const nextText = document.createElement("div");
    const render = page.render({ canvas: bitmap, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    const textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: nextText, viewport });
    void Promise.all([render.promise, textLayer.render()]).then(() => {
      if (disposed) return;
      target.width = bitmap.width; target.height = bitmap.height;
      const context = target.getContext("2d");
      if (!context) throw new Error("PDF canvas is unavailable");
      context.drawImage(bitmap, 0, 0);
      layer.style.cssText = nextText.style.cssText;
      layer.replaceChildren(...nextText.childNodes);
      setReady({ page, zoom });
    }).catch(error => { if (!disposed) setError(String(error)); }).finally(() => { bitmap.width = 0; bitmap.height = 0; });
    return () => { disposed = true; render.cancel(); textLayer.cancel(); };
  }, [page, zoom, live]);
  return <div data-pdf-page={pageNumber} className="pdf-page relative shrink-0 bg-white shadow-sm" style={{ width, height, "--scale-factor": zoom, "--total-scale-factor": zoom * (page?.userUnit ?? 1) } as React.CSSProperties}>
    {live && <><canvas ref={canvas} className="absolute inset-0 size-full" /><div ref={text} className="textLayer" /></>}
    {live && <PdfFindHighlights layer={text} matches={findMatches} selected={find.selected} ready={ready} />}
    {live && <PdfAnnotationLayer annotations={annotations} pageNumber={pageNumber} disabled={quoteNavigationDisabled} onOpen={onAnnotationOpen} />}
    {live && <PdfQuoteRegions regions={quoteRegions} disabled={quoteNavigationDisabled} onNavigate={onQuoteNavigate} />}
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
  return <div className="pdf-reader-tools flex h-9 shrink-0 items-center gap-1 border-b bg-background px-1.5">
    <div className="pdf-reader-leading flex min-w-0 flex-1 items-center gap-1">{leading}</div><div className="pdf-reader-controls contents">{children}</div>{trailing && <div className="pdf-reader-trailing contents">{trailing}</div>}
  </div>;
}

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** With `nativeTools`, the host draws the reader's tools (pdfReaderControls). */
export function PdfViewer({ doc, fullscreen = false, leading, trailing, initialPage, nativeTools = false }: { doc: DocumentRecord; fullscreen?: boolean; leading?: ReactNode; trailing?: ReactNode; initialPage?: number; nativeTools?: boolean }) {
  const nativeSelectionMenu = nativeTools && isNativeHost();
  const savedTextSelection = useRef<ReturnType<typeof readPdfTextSelection>>(null);
  const client = useQueryClient();
  const quoteRegions = usePdfQuoteRegions(doc.moduleId, doc.id);
  const navigateToQuote = usePdfQuoteNavigation(doc.moduleId);
  const root = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const annotations = usePdfAnnotations(doc.id);
  const [writeBlocked, setWriteBlocked] = useState(false);
  useEffect(() => watchWriteAdmission(setWriteBlocked), []);
  const [highlightColor, setHighlightColor] = useState<PdfAnnotationColor>(() => {
    try { return parsePdfAnnotationColor(localStorage.getItem("pdf-highlight-color")) ?? "primary"; } catch { return "primary"; }
  });
  const [showHighlightColors, setShowHighlightColors] = useState(false);
  const chooseHighlightColor = (color: PdfAnnotationColor) => {
    setHighlightColor(color);
    try { localStorage.setItem("pdf-highlight-color", color); } catch { /* Preference storage may be unavailable. */ }
  };
  const [annotationArea, setAnnotationArea] = useState(false);
  type AnnotationEditor = { left: number; top: number; anchorPage: number } & (
    | { kind: "existing"; id: string }
    | { kind: "new"; anchors: readonly PdfAnnotationAnchor[]; excerpt?: string }
    | { kind: "area"; anchors: readonly PdfAnnotationAnchor[] }
  );
  const [annotationEditor, setAnnotationEditor] = useState<AnnotationEditor | null>(null);
  const annotationPosition = useCallback((bounds: DOMRect) => {
    const host = root.current?.getBoundingClientRect();
    return { left: Math.max(8, Math.min((host?.width ?? 280) - 264, bounds.left - (host?.left ?? 0))),
      top: Math.max(40, Math.min((host?.height ?? 400) - 240, bounds.bottom - (host?.top ?? 0) + 6)) };
  }, []);
  const openAnnotation = useCallback((id: string, bounds: DOMRect, page: number) => {
    setAnnotationEditor({ kind: "existing", id, anchorPage: page, ...annotationPosition(bounds) });
  }, [annotationPosition]);
  useEffect(() => { setAnnotationEditor(null); setAnnotationArea(false); }, [doc.id]);
  const [cropping, setCropping] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const pending = useSelector(pendingPdfQuote, state => state);
  const cropBusy = useRef(false);
  const documentIdentity = useRef(doc.id);
  documentIdentity.current = doc.id;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const cancelSelection = useCallback(() => { setSelecting(false); setAnnotationArea(false); }, []);
  useEffect(() => {
    if (!selecting) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") cancelSelection(); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [selecting, cancelSelection]);
  const selectRegion = useCallback(async (canvas: HTMLCanvasElement, region: PdfRegion, page: number) => {
    if (annotationArea) {
      const bounds = canvas.getBoundingClientRect();
      setAnnotationEditor({ kind: "area", anchorPage: page, anchors: [{ page, regions: [region] }], ...annotationPosition(new DOMRect(bounds.left + region.x * bounds.width, bounds.top + region.y * bounds.height, region.width * bounds.width, region.height * bounds.height)) });
      setSelecting(false); setAnnotationArea(false); setShowHighlightColors(false); return;
    }
    if (cropBusy.current || pendingPdfQuote.state) return;
    cropBusy.current = true; setCropping(true); setQuoteError(""); setSelecting(false);
    try {
      const blob = await cropPdfCanvas(canvas, region);
      if (!mounted.current || documentIdentity.current !== doc.id) return;
      if (pendingPdfQuote.state) throw new Error("Another quote is waiting. Finish it, then select this region again.");
      pendingPdfQuote.setState(previous => previous ?? ({ id: crypto.randomUUID(), kind: "image", moduleId: doc.moduleId, file: new File([blob], `${doc.name}, page ${page}.png`, { type: "image/png" }),
        source: { documentId: doc.id, name: doc.name, page, region }, status: "draft" }));
    } catch (error) { setQuoteError(error instanceof Error ? error.message : String(error)); setSelecting(!pendingPdfQuote.state); }
    finally { cropBusy.current = false; setCropping(false); }
  }, [doc.id, doc.moduleId, doc.name, annotationArea, annotationPosition]);
  const navigate = useNavigate();
  const [saved] = useState(() => ({ ...readPdfView(doc.id), ...(initialPage ? { page: initialPage } : {}) }));
  const [zoom, setZoom] = useState(saved.zoom);
  const [pinching, setPinching] = useState(false);
  const zoomValue = useRef(zoom);
  zoomValue.current = zoom;
  const content = useRef<HTMLDivElement>(null);
  const previewPages = useRef<HTMLElement[]>([]);
  const pinchActive = useRef(false);
  const zoomAnchor = useRef<ZoomAnchor | null>(null);
  const finishPinch = useRef<(() => number) | null>(null);
  const [current, setCurrent] = useState(saved.page);
  const [input, setInput] = useState(String(saved.page));
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const loadedPdf = useRef(pdf);
  loadedPdf.current = pdf;
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
    restored.current = false; setPdf(null); setPages([]); setError(""); setSelecting(false);
    if (!doc.available) { requestSyncedFile(doc.id); return; }
    let disposed = false;
    const abort = new AbortController();
    let loading: ReturnType<typeof getDocument> | undefined;
    void (async () => {
      const source = isNativeHost() ? { data: await readNativePdf(doc.id, abort.signal) } : { url: fileUrl(await documentPath({ id: doc.id })) };
      if (disposed) return;
      const asset = (folder: string) => new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, document.baseURI).href;
      loading = getDocument({ ...source, cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
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
    return () => { disposed = true; abort.abort(); void loading?.destroy(); };
    // Not keyed on pageCount: saving it must not reload the document.
  }, [doc.id, doc.available, client]);

  // Fetch the pages about to be drawn.
  useEffect(() => {
    if (!pdf) return;
    for (const index of active) {
      if (requested.current.has(index)) continue;
      requested.current.add(index);
      void pdf.getPage(index + 1).then(page => setPages(previous => {
        if (loadedPdf.current !== pdf) return previous;
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
    if (!element || pinchActive.current) return;
    const rows = latestHeights.current;
    if (!rows.length) return;
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
  const find = usePdfFind(pdf, root, fullscreen, jump);
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
    if (!pdf || !restored.current || current !== shownPage.current) return;
    writePdfView(doc.id, { page: current, zoom });
  }, [doc.id, current, zoom, pdf]);
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
    for (const page of previewPages.current) { page.style.transform = ""; page.style.transformOrigin = ""; page.style.willChange = ""; }
    previewPages.current = [];
    if (content.current) content.current.style.pointerEvents = "";
  }
  function restoreZoomAnchor(anchor: ZoomAnchor | null) {
    const element = container.current;
    const page = anchor && content.current?.children[anchor.page];
    if (element && anchor && page) {
      const bounds = page.getBoundingClientRect();
      element.scrollLeft += bounds.left + bounds.width * anchor.x - anchor.clientX;
      element.scrollTop += bounds.top + bounds.height * anchor.y - anchor.clientY;
      measure();
    }
  }
  useLayoutEffect(() => {
    clearPreview();
    restoreZoomAnchor(zoomAnchor.current);
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
    let previewFrame = 0;
    let preview = zoomValue.current;
    let anchor: ZoomAnchor | null = null;
    let native = false;
    let nativeBase = preview;
    let ignoreWheelUntil = 0;
    let ignoreNativeUntil = 0;
    let suppressNativeGesture = false;
    let panX = 0, panY = 0;
    let touch: { ids: [number, number]; distance: number; base: number; x: number; y: number } | null = null;
    let touchBlocked = false;
    let releaseTouchTargets: (() => void)[] = [];
    const clearTouchTargets = () => { releaseTouchTargets.forEach(release => release()); releaseTouchTargets = []; };
    function finish() {
      if (!anchor) return zoomValue.current;
      clearTimeout(timer);
      cancelAnimationFrame(previewFrame); previewFrame = 0;
      pinchActive.current = false;
      if (touch) {
        touch = null; touchBlocked = true;
        ignoreNativeUntil = ignoreWheelUntil = performance.now() + 250;
      }
      if (native) { native = false; ignoreWheelUntil = performance.now() + 250; }
      if (preview !== zoomValue.current) {
        zoomAnchor.current = anchor;
        setZoom(preview);
      } else { clearPreview(); restoreZoomAnchor(anchor); }
      anchor = null;
      setPinching(false);
      return preview;
    }
    finishPinch.current = finish;
    const show = (value: number, point: { clientX?: number; clientY?: number }) => {
      if (!anchor) {
        panX = 0; panY = 0;
        anchor = captureAnchor.current(point.clientX, point.clientY);
        if (!anchor) return;
        const selection = window.getSelection();
        if (selection?.anchorNode && grid.contains(selection.anchorNode)) selection.removeAllRanges();
        pinchActive.current = true;
        setPinching(true);
        // Promote only the rendered pages, rather than the entire long document.
        // Cache geometry once; incoming events only update the latest scale.
        previewPages.current = Array.from(grid.querySelectorAll("canvas")).flatMap(canvas => canvas.parentElement ? [canvas.parentElement] : []);
        const origin = anchor;
        const origins = previewPages.current.map(page => {
          const bounds = page.getBoundingClientRect();
          return `${origin.clientX - bounds.left}px ${origin.clientY - bounds.top}px`;
        });
        previewPages.current.forEach((page, index) => { page.style.transformOrigin = origins[index]; page.style.willChange = "transform"; });
        grid.style.pointerEvents = "none";
      }
      preview = clampZoom(value);
      if (!previewFrame) previewFrame = requestAnimationFrame(() => {
        previewFrame = 0;
        for (const page of previewPages.current) page.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${preview / zoomValue.current})`;
      });
      clearTimeout(timer);
      // A pause is not the end of a native gesture. Keep its preview until
      // gestureend; a longer watchdog recovers a lost end event.
      timer = touch ? undefined : setTimeout(finish, native ? 2000 : 240);
    };
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (touch || touchBlocked || native || performance.now() < ignoreWheelUntil) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight() : 1);
      show((anchor ? preview : zoomValue.current) * Math.exp(-delta * 0.01), event);
    }
    function gesture(event: Event) {
      event.preventDefault();
      if (event.type === "gesturestart") suppressNativeGesture = !!touch || touchBlocked || performance.now() < ignoreNativeUntil;
      if (suppressNativeGesture) { if (event.type === "gestureend") suppressNativeGesture = false; return; }
      if (touch || touchBlocked || performance.now() < ignoreNativeUntil) return;
      if (event.type === "gesturestart") {
        native = true;
        // Discard a leading wheel preview if WebKit sends both protocols.
        clearTimeout(timer); cancelAnimationFrame(previewFrame); previewFrame = 0; clearPreview(); anchor = null;
        nativeBase = zoomValue.current;
      }
      if ("scale" in event && typeof event.scale === "number" && Number.isFinite(event.scale) && event.scale > 0) show(nativeBase * event.scale, { clientX: "clientX" in event && typeof event.clientX === "number" ? event.clientX : undefined, clientY: "clientY" in event && typeof event.clientY === "number" ? event.clientY : undefined });
      if (event.type === "gestureend") { native = false; ignoreWheelUntil = performance.now() + 250; finish(); }
    }
    const ownTouch = (contact: Touch) => contact.target instanceof Node && element.contains(contact.target);
    const beginTouch = (event: TouchEvent) => {
      if (touchBlocked || event.touches.length < 2) return;
      if (event.touches.length !== 2) {
        if (touch) { event.preventDefault(); finish(); touch = null; touchBlocked = true; }
        return;
      }
      const first = event.touches[0], second = event.touches[1];
      if (touch || !ownTouch(first) || !ownTouch(second)) return;
      const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      if (!distance) return;
      event.preventDefault();
      clearTimeout(timer); cancelAnimationFrame(previewFrame); previewFrame = 0; clearPreview(); anchor = null; native = false; suppressNativeGesture = true;
      touch = { ids: [first.identifier, second.identifier], distance, base: zoomValue.current,
        x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
      show(touch.base, { clientX: touch.x, clientY: touch.y });
      clearTouchTargets();
      // TouchEvents retain their original target. Cancelling a crop removes
      // that overlay, so also track its remaining events on the detached node.
      for (const target of new Set([first.target, second.target])) {
        const forward = (event: Event) => {
          if (!(target instanceof Node) || target.isConnected || !(event instanceof TouchEvent)) return;
          if (event.type === "touchmove") moveTouch(event); else endTouch(event);
        };
        for (const type of ["touchmove", "touchend", "touchcancel"]) target.addEventListener(type, forward, { passive: false });
        releaseTouchTargets.push(() => { for (const type of ["touchmove", "touchend", "touchcancel"]) target.removeEventListener(type, forward); });
      }
    };
    const moveTouch = (event: TouchEvent) => {
      if (touchBlocked) { event.preventDefault(); return; }
      if (!touch) return;
      event.preventDefault();
      const contacts = Array.from(event.touches);
      const first = contacts.find(contact => contact.identifier === touch?.ids[0]);
      const second = contacts.find(contact => contact.identifier === touch?.ids[1]);
      if (!first || !second || contacts.length !== 2) return;
      const x = (first.clientX + second.clientX) / 2, y = (first.clientY + second.clientY) / 2;
      const value = touch.base * Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY) / touch.distance;
      show(value, { clientX: x, clientY: y });
      panX = x - touch.x; panY = y - touch.y;
      if (anchor) anchor = { ...anchor, clientX: x, clientY: y };
    };
    const endTouch = (event: TouchEvent) => {
      if (!touch && !touchBlocked) return;
      event.preventDefault();
      if (event.touches.length >= 2 && event.type !== "touchcancel") return;
      if (event.type === "touchcancel") {
        clearTimeout(timer); cancelAnimationFrame(previewFrame); previewFrame = 0;
        clearPreview(); anchor = null; pinchActive.current = false; setPinching(false);
      } else finish();
      touch = null; touchBlocked = event.touches.length > 0;
      if (!touchBlocked) clearTouchTargets();
      ignoreNativeUntil = ignoreWheelUntil = performance.now() + 250;
    };
    element.addEventListener("touchstart", beginTouch, { capture: true, passive: false });
    element.addEventListener("touchmove", moveTouch, { capture: true, passive: false });
    element.addEventListener("touchend", endTouch, { capture: true, passive: false });
    element.addEventListener("touchcancel", endTouch, { capture: true, passive: false });
    element.addEventListener("wheel", wheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.addEventListener(type, gesture, { passive: false });
    return () => {
      clearTimeout(timer); cancelAnimationFrame(previewFrame); clearTouchTargets(); pinchActive.current = false; finishPinch.current = null; clearPreview();
      element.removeEventListener("touchstart", beginTouch, true);
      element.removeEventListener("touchmove", moveTouch, true);
      element.removeEventListener("touchend", endTouch, true);
      element.removeEventListener("touchcancel", endTouch, true);
      element.removeEventListener("wheel", wheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.removeEventListener(type, gesture);
    };
  }, [doc.available, error]);
  const textMenu = useRef<HTMLDivElement>(null);
  const [textAction, setTextAction] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const menu = textMenu.current;
    if (menu && root.current && textAction) menu.style.left = `${Math.max(8, Math.min(textAction.left, root.current.clientWidth - menu.offsetWidth - 8))}px`;
  }, [textAction]);
  useEffect(() => {
    const reader = content.current;
    const viewport = container.current;
    const host = root.current;
    if (!reader || !viewport || !host) return;
    let frame = 0;
    const clear = () => {
      setTextAction(null);
      savedTextSelection.current = null;
      const selection = window.getSelection();
      if (selection?.anchorNode && reader.contains(selection.anchorNode)) selection.removeAllRanges();
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selected = !selecting && !cropping && !pinching && !pendingPdfQuote.state && readPdfTextSelection(reader, doc);
        if (!selected) { setTextAction(null); return; }
        savedTextSelection.current = selected;
        const bounds = host.getBoundingClientRect(), view = viewport.getBoundingClientRect();
        if (selected.anchor.bottom < view.top || selected.anchor.top > view.bottom) { setTextAction(null); return; }
        setTextAction({ left: Math.max(8, Math.min(bounds.width - 240, selected.anchor.left - bounds.left)),
          top: Math.max(40, Math.min(bounds.height - 36, selected.anchor.top - bounds.top - 32)) });
      });
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    document.addEventListener("selectionchange", update);
    window.addEventListener("keydown", key);
    viewport.addEventListener("scroll", update);
    viewport.addEventListener("pointercancel", clear);
    let width = viewport.clientWidth, height = viewport.clientHeight;
    const resize = new ResizeObserver(() => {
      if (width !== viewport.clientWidth || height !== viewport.clientHeight) {
        width = viewport.clientWidth; height = viewport.clientHeight; clear();
      }
    }); resize.observe(viewport);
    const mutations = new MutationObserver(update); mutations.observe(reader, { childList: true, subtree: true });
    update();
    return () => {
      cancelAnimationFrame(frame); clear(); resize.disconnect(); mutations.disconnect();
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("keydown", key);
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("pointercancel", clear);
    };
  }, [doc.id, doc.name, doc.available, selecting, cropping, pinching, pending?.id, zoom, error]);
  useLayoutEffect(() => {
    if (!annotationEditor) return;
    const editor = annotationEditor;
    const reposition = () => {
      const anchors = editor.kind === "existing" ? annotations.annotations.find(annotation => annotation.id === editor.id)?.anchors : editor.anchors;
      const region = anchors?.find(anchor => anchor.page === editor.anchorPage)?.regions[0];
      const page = content.current?.querySelector<HTMLElement>(`[data-pdf-page="${editor.anchorPage}"]`);
      if (!page || !region) return;
      const bounds = page.getBoundingClientRect();
      const position = annotationPosition(new DOMRect(bounds.left + region.x * bounds.width, bounds.top + region.y * bounds.height, region.width * bounds.width, region.height * bounds.height));
      setAnnotationEditor(previous => previous && (previous.left !== position.left || previous.top !== position.top) ? { ...previous, ...position } : previous);
    };
    reposition();
    const viewport = container.current;
    viewport?.addEventListener("scroll", reposition);
    window.addEventListener("resize", reposition);
    return () => { viewport?.removeEventListener("scroll", reposition); window.removeEventListener("resize", reposition); };
  }, [annotationEditor, annotations.annotations, annotationPosition, zoom]);
  const annotateText = (kind: "highlight" | "comment", color = highlightColor) => {
    if (selecting || cropping || pinching || pending || writeBlocked || !annotations.ready || !content.current) return;
    const selected = readPdfTextSelection(content.current, doc) ?? (nativeSelectionMenu ? savedTextSelection.current : null);
    if (!selected) return;
    const draft = { anchors: selected.anchors, excerpt: selected.parts.map(part => part.text).join("\n") };
    try {
      if (kind === "highlight") { annotations.create({ kind, ...draft, color }); setAnnotationEditor(null); }
      else setAnnotationEditor({ kind: "new", anchorPage: selected.anchors[0].page, ...draft, ...annotationPosition(selected.anchor) });
      savedTextSelection.current = null;
      window.getSelection()?.removeAllRanges(); setTextAction(null); setShowHighlightColors(false);
    } catch (error) { setQuoteError(error instanceof Error ? error.message : String(error)); }
  };
  const highlightArea = (color = highlightColor) => {
    if (annotationEditor?.kind !== "area" || !annotations.ready || writeBlocked) return;
    try { annotations.create({ kind: "highlight", anchors: annotationEditor.anchors, color }); setAnnotationEditor(null); setShowHighlightColors(false); }
    catch (error) { setQuoteError(error instanceof Error ? error.message : String(error)); }
  };
  const quoteText = () => {
    if (selecting || cropping || pinching || pendingPdfQuote.state || !content.current) return;
    const selected = readPdfTextSelection(content.current, doc) ?? (nativeSelectionMenu ? savedTextSelection.current : null);
    if (!selected) { setTextAction(null); return; }
    pendingPdfQuote.setState(previous => previous ?? ({ id: crypto.randomUUID(), kind: "text", moduleId: doc.moduleId, status: "draft", parts: selected.parts }));
    savedTextSelection.current = null;
    if (nativeSelectionMenu) window.getSelection()?.removeAllRanges();
    setTextAction(null);
  };
  // Keep handlers fresh without unregistering on every selection update.
  const selectionActions = useRef({ quoteText, annotateText, chooseHighlightColor });
  selectionActions.current = { quoteText, annotateText, chooseHighlightColor };
  useEffect(() => {
    if (!nativeSelectionMenu) return;
    return pdfSelectionControls.register((action, color) => {
      const actions = selectionActions.current;
      if (action === "quote") actions.quoteText();
      else if (action === "comment") actions.annotateText("comment");
      else if (action === "highlight") {
        const parsed = color === "purple" ? "primary" : parsePdfAnnotationColor(color);
        if (parsed) actions.chooseHighlightColor(parsed);
        actions.annotateText("highlight", parsed ?? undefined);
      }
    });
  }, [nativeSelectionMenu, doc.id]);
  useEffect(() => {
    if (!nativeSelectionMenu) return;
    let previous = "";
    const update = () => {
      const selected = content.current && !selecting && !cropping && !pinching && !pendingPdfQuote.state && !annotationEditor
        ? readPdfTextSelection(content.current, doc) : null;
      if (selected) savedTextSelection.current = selected;
      const active = !!selected;
      const writable = active && annotations.ready && !writeBlocked;
      const state = { active, canQuote: active, canHighlight: writable, canComment: writable, lastColor: highlightColor === "primary" ? "purple" : highlightColor };
      const json = JSON.stringify(state);
      if (json !== previous) { previous = json; postNativeEvent("pdfSelectionChanged", state); }
    };
    // A fresh touch invalidates the cached selection. Menu taps happen in UIKit,
    // so they can still use the snapshot if WebKit collapses it on dismissal.
    const invalidate = () => { savedTextSelection.current = null; };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", invalidate);
    update();
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", invalidate);
      postNativeEvent("pdfSelectionChanged", { active: false, canQuote: false, canHighlight: false, canComment: false, lastColor: "purple" });
    };
  }, [nativeSelectionMenu, doc.id, doc.name, selecting, cropping, pinching, pending?.id, annotationEditor, annotations.ready, writeBlocked, highlightColor]);
  const pageRequest = useSelector(pdfPageRequest, state => state);
  useEffect(() => {
    if (pageRequest?.id === doc.id && pages.length) { jump(Math.max(1, Math.min(pages.length, pageRequest.page))); pdfPageRequest.setState(() => null); }
  }, [pageRequest, doc.id, pages.length]);
  const toggleSelection = useCallback(() => {
    if (cropBusy.current || pendingPdfQuote.state || !pdf) return;
    setQuoteError(""); setAnnotationArea(false); setSelecting(value => !value);
  }, [pdf]);
  const openBeside = useCallback(() => {
    const finalZoom = finishPinch.current?.() ?? zoomValue.current;
    writePdfView(doc.id, { page: shownPage.current, zoom: finalZoom });
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
    if (!textAction || annotationEditor || !annotations.ready || writeBlocked) return;
    return registerCommand({ ...action("text.highlight"), id: "pdf.highlight", title: "Highlight selected PDF text", shortcut: formatKeys(action("text.highlight").keys), run: () => annotateText("highlight") });
  }, [textAction, annotationEditor, annotations.ready, writeBlocked, annotateText]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!acceptsPdfShortcut(event, [root.current, root.current?.closest('[data-pdf-note]') ?? null, fullscreen ? document.getElementById("pdf-toolbar") : null])) return;
      if (matchesShortcut(event, action("text.highlight").keys)) {
        if (annotationEditor || selecting || cropping || pinching || pending || writeBlocked || !annotations.ready || !content.current || !readPdfTextSelection(content.current, doc)) return;
        event.preventDefault(); event.stopPropagation(); annotateText("highlight");
      } else if (matchesShortcut(event, action("pdf.select-region").keys)) {
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
  }, [fullscreen, pdf, pending, cropping, doc.moduleId, toggleSelection, openBeside, showCursorAction, annotateText, annotationEditor, selecting, pinching, writeBlocked, annotations.ready]);
  useEffect(() => {
    if (!fullscreen || pending?.moduleId !== doc.moduleId || pending.status !== "draft") return;
    return registerCommand({ ...action("pdf.quote.insert"), keywords: ["pdf", "quote", "cursor"], run: showCursorAction });
  }, [fullscreen, pending?.moduleId, pending?.status, doc.moduleId, showCursorAction]);
  const activeSet = useMemo(() => new Set(active), [active]);

  // The backdrop matches the app header, so the page sits on one surface.
  const toggleAnnotate = () => { setAnnotationEditor(null); setAnnotationArea(value => !value); setSelecting(!annotationArea); };
  const nativeActions = useRef<PdfReaderActions | null>(null);
  nativeActions.current = {
    zoomIn: () => changeZoom((finishPinch.current?.() ?? zoom) + 0.1),
    zoomOut: () => changeZoom((finishPinch.current?.() ?? zoom) - 0.1),
    toggleSelect: toggleSelection,
    toggleAnnotate,
    goToPage: page => { if (pages.length) jump(Math.max(1, Math.min(pages.length, Math.round(page)))); },
    openBeside,
  };
  const canSelect = !pending && !cropping && !!pdf;
  const nativeState = nativeTools ? JSON.stringify({
    page: current, pageCount: pages.length || doc.pageCount || 0, zoom: Math.round(zoom * 100),
    selecting: selecting && !annotationArea, annotating: annotationArea,
    canSelect, canAnnotate: canSelect && annotations.ready && !writeBlocked, canZoomIn: zoom < 3, canZoomOut: zoom > 0.25,
  }) : null;
  useEffect(() => {
    if (!nativeState) return;
    const actions: PdfReaderActions = {
      zoomIn: () => nativeActions.current?.zoomIn(), zoomOut: () => nativeActions.current?.zoomOut(),
      toggleSelect: () => nativeActions.current?.toggleSelect(), toggleAnnotate: () => nativeActions.current?.toggleAnnotate(),
      goToPage: page => nativeActions.current?.goToPage(page), openBeside: () => nativeActions.current?.openBeside(),
    };
    return pdfReaderControls.set({ documentId: doc.id, state: JSON.parse(nativeState), actions });
  }, [nativeState, doc.id]);
  return <div ref={root} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape" && annotationEditor?.kind === "area") setAnnotationEditor(null); }} className="pdf-viewer relative flex h-full min-h-0 min-w-0 flex-col bg-background">
    {!nativeSelectionMenu && textAction && !annotationEditor && !pending && !selecting && !cropping && !pinching && <div ref={textMenu} role="group" aria-label="PDF text actions" className="pdf-floating-menu absolute z-30 w-max max-w-[calc(100%-1rem)] rounded-lg floating-surface p-1 text-foreground shadow-md" style={textAction}>
      <div className="flex items-center gap-0.5 overflow-x-auto">
        <Button size="xs" variant="ghost" className="px-1.5" aria-label="Quote text" onPointerDown={event => event.preventDefault()} onClick={quoteText}><Quote aria-hidden="true" />Quote</Button>
        <Button size="xs" variant="ghost" className="px-1.5" title={`Highlight (${formatKeys(action("text.highlight").keys)})`} aria-keyshortcuts="Meta+Shift+H Control+Shift+H" disabled={!annotations.ready || writeBlocked} onPointerDown={event => event.preventDefault()} onClick={() => annotateText("highlight")}><Highlighter aria-hidden="true" />Highlight</Button>
        <ToolButton size="icon-xs" label="Highlight colour" pressed={showHighlightColors} aria-expanded={showHighlightColors} disabled={!annotations.ready || writeBlocked} onPointerDown={event => event.preventDefault()} onClick={() => setShowHighlightColors(value => !value)}>
          <span className="size-2 rounded-full" style={{ backgroundColor: pdfHighlightColors[highlightColor].value }} /><ChevronDown className="size-3" />
        </ToolButton>
        <Button size="xs" variant="ghost" className="px-1.5" disabled={!annotations.ready || writeBlocked} onPointerDown={event => event.preventDefault()} onClick={() => annotateText("comment")}><MessageSquare aria-hidden="true" />Comment</Button>
      </div>
      {showHighlightColors && <div className="mt-1 px-1"><PdfHighlightColors color={highlightColor} disabled={!annotations.ready || writeBlocked} onChange={color => { chooseHighlightColor(color); annotateText("highlight", color); }} /></div>}
    </div>}
    {annotationEditor?.kind === "area" && <div role="group" aria-label="PDF area actions" className="pdf-floating-menu absolute z-30 w-max max-w-[calc(100%-1rem)] rounded-lg floating-surface p-1 text-foreground shadow-md" style={annotationEditor}>
      <div className="flex items-center gap-0.5">
        <Button size="xs" variant="ghost" className="px-1.5" aria-label="Highlight area" disabled={!annotations.ready || writeBlocked} onClick={() => highlightArea()}><Highlighter aria-hidden="true" />Highlight</Button>
        <ToolButton size="icon-xs" label="Highlight colour" pressed={showHighlightColors} aria-expanded={showHighlightColors} disabled={!annotations.ready || writeBlocked} onClick={() => setShowHighlightColors(value => !value)}>
          <span className="size-2 rounded-full" style={{ backgroundColor: pdfHighlightColors[highlightColor].value }} /><ChevronDown className="size-3" />
        </ToolButton>
        <Button size="xs" variant="ghost" className="px-1.5" aria-label="Comment on area" disabled={!annotations.ready || writeBlocked} onClick={() => setAnnotationEditor({ ...annotationEditor, kind: "new" })}><MessageSquare aria-hidden="true" />Comment</Button>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
        <ToolButton size="icon-xs" className="pdf-menu-close" label="Cancel area annotation" onClick={() => setAnnotationEditor(null)}><X /></ToolButton>
      </div>
      {showHighlightColors && <div className="mt-1 px-1"><PdfHighlightColors color={highlightColor} disabled={!annotations.ready || writeBlocked} onChange={color => { chooseHighlightColor(color); highlightArea(color); }} /></div>}
    </div>}
    {annotationEditor && annotationEditor.kind !== "area" && (() => {
      const existing = annotationEditor.kind === "existing" ? annotations.annotations.find(annotation => annotation.id === annotationEditor.id) : undefined;
      if (annotationEditor.kind === "existing" && !existing) return null;
      return <PdfAnnotationPopover key={annotationEditor.kind === "existing" ? annotationEditor.id : "new"} position={annotationEditor} color={existing?.color ?? highlightColor} onColorChange={existing ? color => { if (!annotations.updateColor({ id: existing.id, color })) throw new Error("This annotation has been deleted."); chooseHighlightColor(color); } : undefined} body={existing?.body ?? ""} required={existing ? existing.kind === "comment" : true} disabled={!annotations.ready || writeBlocked} saving={annotations.saving} persistenceError={annotations.error} onRetry={annotations.retry} onClose={() => setAnnotationEditor(null)} onSave={body => {
        if (writeBlocked || !annotations.ready) throw new Error("Annotation writes are suspended.");
        if (annotationEditor.kind === "existing") {
          if (!annotations.updateComment({ id: annotationEditor.id, body })) throw new Error("This annotation has been deleted.");
        } else {
          annotations.create({ kind: "comment", anchors: annotationEditor.anchors, excerpt: annotationEditor.excerpt, body, color: highlightColor });
        }
        setAnnotationEditor(null);
      }} onDelete={existing ? () => { annotations.remove(existing.id); setAnnotationEditor(null); } : undefined} />;
    })()}
    {(!annotations.ready || annotations.saving || annotations.error) && <div className="absolute bottom-3 right-3 z-30 max-w-64 rounded floating-surface p-2 text-xs shadow" role={annotations.error ? "alert" : "status"}>
      {annotations.error || (annotations.saving ? "Saving annotations…" : "Loading annotations…")}
      {annotations.error && <button type="button" className="ml-2 underline" disabled={writeBlocked} onClick={() => { try { annotations.retry(); } catch (error) { setQuoteError(error instanceof Error ? error.message : String(error)); } }}>Retry annotations</button>}
    </div>}
    {!nativeTools && <ReaderTools fullscreen={fullscreen} leading={leading} trailing={trailing}>
      {find.button}
      <div className="flex items-center gap-1 text-xs tabular-nums"><input aria-label="Page number" disabled={!pages.length} className="w-9 rounded bg-transparent px-1 text-right focus:bg-accent focus:outline-none" value={input} onInput={event => setInput(event.currentTarget.value)} onBlur={() => setInput(String(current))} onKeyDown={event => {
        if (event.key !== "Enter") return;
        const page = parsePage(event.currentTarget.value, pages.length); if (page !== null) jump(page); else setInput(String(current));
      }} /><span className="whitespace-nowrap text-muted-foreground">/ {pages.length || doc.pageCount || "?"}</span></div>
      <span aria-hidden="true" className="pdf-tool-divider hidden" />
      <ToolButton label={`Zoom out (${Math.round(zoom * 100)}%)`} disabled={zoom <= 0.25} onClick={() => changeZoom((finishPinch.current?.() ?? zoom) - 0.1)}><ZoomOut /></ToolButton>
      <span className="min-w-8 text-center text-[11px] tabular-nums text-muted-foreground" aria-label="Zoom level">{Math.round(zoom * 100)}%</span>
      <ToolButton label={`Zoom in (${Math.round(zoom * 100)}%)`} disabled={zoom >= 3} onClick={() => changeZoom((finishPinch.current?.() ?? zoom) + 0.1)}><ZoomIn /></ToolButton>
      <span aria-hidden="true" className="pdf-tool-divider hidden" />
      <ToolButton hint={formatKeys(action("pdf.select-region").keys)} label="Select region" pressed={selecting && !annotationArea} disabled={!!pending || cropping || !pdf} onClick={toggleSelection}><SquareDashedMousePointer /></ToolButton>
      <ToolButton label="Annotate area" pressed={annotationArea} disabled={!!pending || cropping || !pdf || !annotations.ready || writeBlocked} onClick={toggleAnnotate}><Highlighter /></ToolButton>
      {fullscreen && <ToolButton label="Open beside note" hint={formatKeys(action("pdf.open-beside").keys)} onClick={openBeside}>
        {/* The small arrow says this moves the PDF into the note's side panel. */}
        <span className="relative"><PanelRight /><ArrowUpRight strokeWidth={3} className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-background" /></span>
      </ToolButton>}
    </ReaderTools>}
    {nativeTools && <div className="flex justify-end">{find.button}</div>}
    {find.bar}
    {(selecting || cropping || quoteError || (fullscreen && pending?.moduleId === doc.moduleId)) && <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex max-h-[calc(100%-1.5rem)] justify-center">
      <div className="pdf-hint pointer-events-auto flex min-w-0 max-w-sm flex-wrap items-center gap-2 overflow-y-auto rounded-lg floating-surface p-2 text-xs shadow-md [overflow-wrap:anywhere]" role="status">
        {selecting && !pending && <><span className="min-w-0 flex-1">{annotationArea ? "Drag to highlight or comment on an area" : "Drag to select a quote"}</span><ToolButton size="icon-xs" className="pdf-menu-close" label="Exit selection" onClick={cancelSelection}><X /></ToolButton></>}
        {cropping && "Preparing quote"}{quoteError && <span role="alert">{quoteError}</span>}
        {fullscreen && pending?.moduleId === doc.moduleId && <>{pending.status === "draft" ? "Quote ready" : pending.status === "saving" ? "Saving quote" : "Quote needs attention"}<Button size="xs" title={`Insert at cursor (${formatKeys(action("pdf.quote.insert").keys)})`} aria-keyshortcuts="Meta+Enter Control+Enter" disabled={pending.status !== "draft"} onClick={showCursorAction}>Insert at cursor</Button>{pending.status === "draft" && <Button size="xs" variant="ghost" onClick={() => pendingPdfQuote.setState(current => current?.id === pending.id && current.status === "draft" ? null : current)}>Discard</Button>}</>}
      </div>
    </div>}
    {!doc.available ? <div className="m-auto grid gap-2 p-6 text-center text-sm text-muted-foreground"><p>Downloading from your other devices</p><p>{(doc.size / 1024 / 1024).toFixed(1)} MB</p></div> : error ? <p role="alert" className="m-auto p-4 text-sm text-destructive">{error}</p> : <div ref={container} className="pdf-viewport min-h-0 flex-1 overflow-auto overscroll-contain" style={{ overflowAnchor: "none" }} onScroll={scheduleMeasure}>
      {!pages.length && <p className="p-8 text-center text-sm text-muted-foreground">Loading PDF</p>}
      <div ref={content} className="grid min-w-full w-max justify-items-center gap-4 pb-4">{sizes.map((size, index) => <PdfPage find={find} key={index} page={pages[index]} pageNumber={index + 1} width={size.width} height={size.height} zoom={zoom} active={activeSet.has(index)} annotations={annotations.annotations} onAnnotationOpen={openAnnotation} quoteRegions={quoteRegions.get(index + 1)} onQuoteNavigate={navigateToQuote} quoteNavigationDisabled={selecting || cropping || pinching} selecting={selecting && !pending && !cropping && !pinching} onCancel={cancelSelection} onSelect={selectRegion} />)}</div>
    </div>}
  </div>;
}
