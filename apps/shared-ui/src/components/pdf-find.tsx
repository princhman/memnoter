import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { ToolButton } from "./ui/tool-button";
import { FIND_EVENT } from "@/lib/app-events";
import { action, matchesShortcut } from "@/lib/shortcuts";

type Match = { page: number; start: number; end: number };

export function usePdfFind(pdf: PDFDocumentProxy | null, root: RefObject<HTMLDivElement | null>, fullscreen: boolean, jump: (page: number) => void) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [texts, setTexts] = useState<string[]>([]);
  const [failure, setFailure] = useState("");
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const cache = useRef<{ pdf: PDFDocumentProxy; texts: string[] } | null>(null);
  useEffect(() => { setOpen(false); setQuery(""); setTexts([]); cache.current = null; }, [pdf]);
  useEffect(() => {
    if (!pdf || !open || cache.current?.pdf === pdf) return;
    let cancelled = false;
    setFailure("");
    void (async () => {
      const result: string[] = [];
      for (let page = 1; page <= pdf.numPages; page++) {
        if (cancelled) return;
        const content = await (await pdf.getPage(page)).getTextContent();
        result.push(content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join(""));
      }
      if (!cancelled) { cache.current = { pdf, texts: result }; setTexts(result); }
    })().catch(error => { if (!cancelled) setFailure(String(error)); });
    return () => { cancelled = true; };
  }, [pdf, open]);
  const matches = useMemo(() => {
    if (!open || !query) return [];
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
    return texts.flatMap((text, index) => Array.from(text.matchAll(pattern), match => ({ page: index + 1, start: match.index, end: match.index + match[0].length })));
  }, [texts, query, open]);
  const selected = matches[current];
  const jumpRef = useRef(jump); jumpRef.current = jump;
  useEffect(() => { if (selected) jumpRef.current(selected.page); }, [selected]);
  const show = () => { setOpen(true); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); };
  const close = () => { setOpen(false); setQuery(""); setCurrent(0); root.current?.focus(); };
  const step = (delta: number) => { if (matches.length) setCurrent(value => (value + delta + matches.length) % matches.length); };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !(root.current?.contains(target) || fullscreen && document.getElementById("pdf-toolbar")?.contains(target))) return;
      if (target.closest('[role="dialog"], [role="menu"]')) return;
      if (matchesShortcut(event, action("find.open").keys)) { event.preventDefault(); event.stopPropagation(); show(); }
      else if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    const nativeFind = (event: Event) => {
      const focused = document.activeElement;
      if (focused && (root.current?.contains(focused) || fullscreen && document.getElementById("pdf-toolbar")?.contains(focused))) {
        event.stopImmediatePropagation(); show();
      }
    };
    window.addEventListener("keydown", handle, true);
    window.addEventListener(FIND_EVENT, nativeFind, true);
    return () => { window.removeEventListener("keydown", handle, true); window.removeEventListener(FIND_EVENT, nativeFind, true); };
  });
  const button = <ToolButton label="Find in PDF" pressed={open} onClick={() => open ? close() : show()}><Search /></ToolButton>;
  const bar = open && <div role="search" aria-label="Find in PDF" className="flex shrink-0 items-center gap-1 bg-background p-1">
    <input ref={input} aria-label="Find in PDF" placeholder="Find" className="h-7 min-w-0 flex-1 rounded-md bg-muted px-2 text-sm outline-none placeholder:text-muted-foreground" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={query} onChange={event => { setQuery(event.target.value); setCurrent(0); }} onKeyDown={event => {
      if (["Enter", "ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); step(event.key === "ArrowUp" || event.shiftKey ? -1 : 1); }
    }} />
    <span role="status" className="shrink-0 text-xs text-muted-foreground tabular-nums">{failure ? "Search failed" : query && cache.current?.pdf !== pdf ? "Searching…" : `${selected ? current + 1 : 0} / ${matches.length}`}</span>
    <ToolButton label="Previous PDF match" size="icon-xs" disabled={!matches.length} onClick={() => step(-1)}><ChevronUp /></ToolButton>
    <ToolButton label="Next PDF match" size="icon-xs" disabled={!matches.length} onClick={() => step(1)}><ChevronDown /></ToolButton>
  </div>;
  return { button, bar, matches, selected };
}

// Ranges leave PDF.js's text nodes intact for selection, copying and annotations.
export function PdfFindHighlights({ layer, matches, selected, ready }: { layer: RefObject<HTMLDivElement | null>; matches: Match[]; selected?: Match; ready: unknown }) {
  const [rects, setRects] = useState<{ left: number; top: number; width: number; height: number; current: boolean }[]>([]);
  const active = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element || !ready) { setRects([]); return; }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: node => node.nodeType === Node.TEXT_NODE || node.nodeName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const nodes: { node: Node; start: number; end: number }[] = [];
    let offset = 0;
    while (walker.nextNode()) { const node = walker.currentNode; const start = offset; offset += node.nodeName === "BR" ? 1 : node.textContent?.length ?? 0; nodes.push({ node, start, end: offset }); }
    const bounds = element.getBoundingClientRect();
    setRects(matches.flatMap(match => {
      const first = nodes.find(node => node.node.nodeType === Node.TEXT_NODE && node.end > match.start), last = nodes.find(node => node.node.nodeType === Node.TEXT_NODE && node.end >= match.end);
      if (!first || !last) return [];
      const range = document.createRange(); range.setStart(first.node, match.start - first.start); range.setEnd(last.node, match.end - last.start);
      return Array.from(range.getClientRects(), rect => ({ left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height, current: match === selected }));
    }));
  }, [layer, matches, selected, ready]);
  useLayoutEffect(() => { active.current?.scrollIntoView({ block: "center", inline: "nearest" }); }, [rects]);
  return <div className="pointer-events-none absolute inset-0">{rects.map((rect, index) => <div key={index} ref={rect.current ? active : undefined} data-pdf-find-match={rect.current ? "current" : "match"} className={rect.current ? "absolute rounded-sm bg-primary/50 outline outline-2 outline-primary" : "absolute rounded-sm bg-primary/25"} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}</div>;
}
