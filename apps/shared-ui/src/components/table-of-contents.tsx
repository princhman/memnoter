import { TOC_ID_ATTRIBUTE } from "../lib/outline.ts";
import { pointInTriangle, type Point } from "@/lib/menu-aim";
import { isNativeHost } from "@/lib/backend";
import { headingNumbers } from "@/lib/heading-numbering";
import {
  type CSSProperties,
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Editor } from "@tiptap/core";
import type {
  TableOfContentData,
  TableOfContentDataItem,
} from "@tiptap/extension-table-of-contents";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { createStore, useSelector } from "@tanstack/react-store";
import katex from "katex";
import { groupMathScripts } from "@/lib/latex-render";
import { ChevronRight } from "lucide-react";
import { getFocusedSectionRange } from "@/lib/section-focus";
import { getFoldedRanges } from "@/lib/heading-fold";
import { appStore } from "@/lib/store";

export type TocStore = ReturnType<typeof createTocStore>;

export function createTocStore() {
  return createStore<TableOfContentData>([]);
}

// Dash width in the rail, by nesting level.
const DASH_WIDTHS = [28, 20, 14, 9];
// Keeps the popup this far from the window edges.
const VIEWPORT_MARGIN = 16;
// Headings keep inline math as raw LaTeX, so render it like the editor does.
function HeadingTitle({ node }: { node: PMNode }) {
  const html = useMemo(() => {
    const parts: string[] = [];
    node.forEach((child) => {
      if (child.type.name === "inlineMath") {
        parts.push(
          katex.renderToString(groupMathScripts(child.textContent.replace(/\u200b/g, "")), {
            throwOnError: false,
            displayMode: false,
          }),
        );
      } else if (child.isText) {
        const span = document.createElement("span");
        span.textContent = child.text ?? "";
        parts.push(span.innerHTML);
      }
    });
    return parts.join("");
  }, [node]);

  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function DesktopTableOfContents({
  editor,
  store,
  numbered = false,
}: {
  editor: Editor | null;
  store: TocStore;
  numbered?: boolean;
}) {
  const showBlocks = useSelector(appStore, (state) => state.foldableBlocksInOutline);
  const doc = useEditorState({ editor, selector: ({ editor }) => numbered || showBlocks ? editor?.state.doc : null, equalityFn: Object.is });
  const numberMap = useMemo(() => numbered && doc ? headingNumbers(doc) : new Map<number, string>(), [doc, numbered]);
  const numberAt = (pos: number) => numbered ? `${numberMap.get(pos) ?? ""} ` : "";
  const allItems = useSelector(store, (state) => state);
  // Focus changes don't touch the document, so the TOC extension won't report them.
  const focusRange = useEditorState({
    editor,
    selector: ({ editor }) => {
      const range = editor ? getFocusedSectionRange(editor.state) : null;
      return range ? `${range.from}:${range.to}` : null;
    },
  });
  // Folding doesn't touch the document either. Serialised so equal folds compare equal.
  const foldedRanges = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor ? JSON.stringify(getFoldedRanges(editor.state)) : "[]",
  });
  const folded = useMemo(
    () =>
      JSON.parse(foldedRanges ?? "[]") as ReturnType<typeof getFoldedRanges>,
    [foldedRanges],
  );
  // Headings inside a folded section are hidden in the editor, so leave them out
  // here too; their folded heading is marked instead.
  const items = useMemo(() => {
    const [from, to] = focusRange?.split(":").map(Number) ?? [];
    // Both the outline and folded ranges are in document order. Sweep once,
    // rather than searching every fold for every heading.
    let rangeIndex = 0;
    return allItems.filter(item => {
      while (rangeIndex < folded.length && folded[rangeIndex].to <= item.pos) rangeIndex++;
      const range = folded[rangeIndex];
      return (!focusRange || (item.pos >= from && item.pos < to))
        && !(range && item.pos >= range.from && item.pos < range.to);
    });
  }, [allItems, focusRange, folded]);
  const blocks = useMemo(() => {
    const result: { pos: number; title: PMNode }[] = [];
    if (!showBlocks || !doc) return result;
    const [from, to] = focusRange?.split(":").map(Number) ?? [];
    doc.forEach((node, pos) => {
      const title = node.firstChild;
      if (node.type.name !== "details" || !title
        || (focusRange && (pos < from || pos >= to))
        || folded.some((range) => pos >= range.from && pos < range.to)) return;
      result.push({ pos, title });
    });
    return result;
  }, [showBlocks, doc, focusRange, folded]);
  const shallowLevels = useMemo(() => [...new Set(items.map(item => item.originalLevel))].sort((a, b) => a - b).slice(0, 2), [items]);
  const minLevel = shallowLevels[0];
  const roots = useMemo(() => items.filter(item => item.originalLevel === minLevel), [items, minLevel]);
  const sectionAt = (pos: number) => {
    let low = 0, high = roots.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (roots[middle].pos <= pos) low = middle + 1;
      else high = middle;
    }
    return roots[low - 1];
  };
  // Publish a section identity, not the cursor offset. In-section selections
  // must not rebuild the rail or recreate its layout observer.
  const selectionRootId = useEditorState({
    editor,
    selector: ({ editor }) => editor ? sectionAt(editor.state.selection.from)?.id ?? null : null,
  });
  let activeItem = items[0];
  for (const item of items) if (item.isScrolledOver) activeItem = item;
  const activeId = activeItem?.id;
  const currentRoot = roots.find(item => item.id === selectionRootId) ?? sectionAt(activeItem?.pos ?? -1);
  const nextRoot = roots[roots.findIndex(item => item.id === currentRoot?.id) + 1];
  const railItems = items.filter(item => shallowLevels.includes(item.originalLevel)
    || (currentRoot && item.pos >= currentRoot.pos && (!nextRoot || item.pos < nextRoot.pos)));
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hovered = railItems.find(item => item.id === hoveredId);
  const hoveredIndex = items.findIndex(item => item.id === hoveredId);
  const descendants: TableOfContentData = [];
  if (hovered) {
    for (const item of items.slice(hoveredIndex + 1)) {
      if (item.originalLevel <= hovered.originalLevel) break;
      descendants.push(item);
    }
  }
  const relatedIds = new Set([hovered?.id, ...descendants.map(item => item.id)]);
  const [pinned, setPinned] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const dashRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<Point | null>(null);
  const aimOrigin = useRef<Point | null>(null);
  const pendingAim = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pressType = useRef("");
  const suppressFocus = useRef(false);
  const popupId = useId();
  const foldedHeadings = useMemo(() => new Set(folded.map(range => range.heading)), [folded]);
  const isFolded = (item: TableOfContentDataItem) => foldedHeadings.has(item.pos);

  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }
  function cancelAim() {
    if (pendingAim.current) clearTimeout(pendingAim.current.timer);
    pendingAim.current = null;
    aimOrigin.current = null;
  }
  function closePopup() {
    cancelAim();
    pointer.current = null;
    cancelClose();
    setHoveredId(null);
    setPinned(false);
  }
  function openPopup(id: string) {
    cancelAim();
    cancelClose();
    setHoveredId(id);
  }
  function trackPointer(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch" || pinned) return;
    const point = { x: event.clientX, y: event.clientY };
    const previous = pointer.current;
    pointer.current = point;
    const dash = (event.target as Element).closest<HTMLButtonElement>(".toc-dash");
    const id = dash?.dataset.headingId;
    if (!id || id === hoveredId) { cancelAim(); return; }
    const bounds = popupRef.current?.getBoundingClientRect();
    const origin = aimOrigin.current ?? previous;
    // The popup sits to the left. Vertical scrubbing must never be delayed.
    if (bounds && origin && previous && point.x < previous.x && pointInTriangle(point, origin,
      { x: bounds.right, y: bounds.top }, { x: bounds.right, y: bounds.bottom })) {
      aimOrigin.current = origin;
      if (pendingAim.current) clearTimeout(pendingAim.current.timer);
      pendingAim.current = { id, timer: setTimeout(() => openPopup(id), 150) };
      return;
    }
    openPopup(id);
  }
  function returnToDash() {
    suppressFocus.current = true;
    if (hoveredId) dashRefs.current.get(hoveredId)?.focus({ preventScroll: true });
    suppressFocus.current = false;
  }
  useEffect(() => () => { cancelClose(); cancelAim(); }, []);
  useEffect(() => {
    closePopup();
    if (editor && !editor.isDestroyed) editor.storage.tableOfContents.scrollHandler();
  }, [editor, focusRange, foldedRanges]);
  useEffect(() => {
    if (!pinned) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !navRef.current?.contains(event.target)) closePopup();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [pinned]);

  useLayoutEffect(() => {
    const position = () => {
      const popup = popupRef.current;
      const nav = navRef.current;
      const dash = hoveredId ? dashRefs.current.get(hoveredId) : null;
      if (!popup || !nav || !dash) return;
      const bounds = nav.getBoundingClientRect();
      const anchor = dash.getBoundingClientRect();
      const contentTop = editor?.view.dom.closest(".app-scroll-container")?.getBoundingClientRect().top ?? 0;
      const minTop = Math.max(VIEWPORT_MARGIN, contentTop + VIEWPORT_MARGIN);
      popup.style.maxHeight = `${Math.max(0, window.innerHeight - minTop - VIEWPORT_MARGIN)}px`;
      popup.style.top = `${Math.max(minTop, Math.min(anchor.top + anchor.height / 2 - popup.offsetHeight / 2,
        window.innerHeight - VIEWPORT_MARGIN - popup.offsetHeight)) - bounds.top}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (navRef.current) observer.observe(navRef.current);
    if (popupRef.current) observer.observe(popupRef.current);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [hoveredId, items, selectionRootId, editor]);

  useLayoutEffect(() => {
    const popup = popupRef.current;
    const active = popup?.querySelector<HTMLElement>('[data-active="true"]');
    if (!popup || !active) return;
    const bounds = popup.getBoundingClientRect();
    const row = active.getBoundingClientRect();
    if (row.top < bounds.top) popup.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) popup.scrollTop += row.bottom - bounds.bottom;
  }, [hoveredId, activeId]);

  function scrollTo(item: TableOfContentDataItem) {
    const heading = editor?.view.dom.querySelector<HTMLElement>(`[${TOC_ID_ATTRIBUTE}="${CSS.escape(item.id)}"]`) ?? item.dom;
    heading.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderRow(item: TableOfContentDataItem) {
    return <button key={item.id} type="button" className="toc-item"
      aria-label={numberAt(item.pos) + item.textContent} data-active={item.id === activeId}
      style={{ paddingLeft: `${0.5 + Math.max(0, item.originalLevel - hovered!.originalLevel) * 0.625}rem` }}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { scrollTo(item); closePopup(); }}>
      <span className="toc-item-title">{numberAt(item.pos)}<HeadingTitle node={item.node} /></span>
      {isFolded(item) && <ChevronRight aria-label="Folded" />}
    </button>;
  }

  // A block belongs to the heading above it, up to the next heading.
  function renderBlockRows(item: TableOfContentDataItem) {
    const next = items[items.indexOf(item) + 1]?.pos ?? Infinity;
    const level = Math.max(0, item.originalLevel - hovered!.originalLevel) + 1;
    return blocks.filter((block) => block.pos > item.pos && block.pos < next).map((block) =>
      <button key={`block:${block.pos}`} type="button" className="toc-item toc-block"
        aria-label={block.title.textContent || "Untitled block"}
        style={{ paddingLeft: `${0.5 + level * 0.625}rem` }}
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          const element = editor?.view.nodeDOM(block.pos);
          if (element instanceof Element) element.scrollIntoView({ behavior: "smooth", block: "start" });
          closePopup();
        }}>
        <span className="toc-item-title"><ChevronRight className="toc-block-icon" aria-hidden="true" />
          {block.title.childCount ? <HeadingTitle node={block.title} /> : "Untitled block"}</span>
      </button>);
  }

  if (!editor || !items.length) return null;
  return <nav ref={navRef} className="toc" aria-label="Table of contents"
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault(); returnToDash(); closePopup();
      }
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closePopup(); }}
    onPointerEnter={cancelClose}
    onPointerMove={trackPointer}
    onPointerLeave={event => {
      cancelAim();
      if (event.pointerType !== "touch" && !pinned && !navRef.current?.contains(document.activeElement)) {
        cancelClose(); closeTimer.current = setTimeout(closePopup, 300);
      }
    }}>
    {hovered && <div ref={popupRef} id={popupId} className="toc-popup" role="region"
      aria-label={`Contents of ${numberAt(hovered.pos) + hovered.textContent}`}
      onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".toc-item")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const target = event.key === "ArrowDown" ? Math.min(index + 1, buttons.length - 1)
          : event.key === "ArrowUp" ? Math.max(index - 1, 0)
          : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
        if (target !== null) { event.preventDefault(); buttons[target]?.focus(); }
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault(); returnToDash();
        }
      }}>
      {[hovered, ...descendants].map(item => <Fragment key={item.id}>
        {renderRow(item)}
        {renderBlockRows(item)}
      </Fragment>)}
    </div>}
    <div className="toc-rail" style={{ "--toc-rows": railItems.length } as CSSProperties}>
      {railItems.map((item, index) => <button key={item.id} type="button" className="toc-dash"
        ref={node => { if (node) dashRefs.current.set(item.id, node); else dashRefs.current.delete(item.id); }}
        data-heading-id={item.id} data-active={item.id === activeId} data-folded={isFolded(item)} data-related={relatedIds.has(item.id)}
        aria-label={numberAt(item.pos) + item.textContent} aria-expanded={hoveredId === item.id}
        aria-controls={hoveredId === item.id ? popupId : undefined}
        onMouseDown={event => event.preventDefault()}
        onPointerDown={event => { pressType.current = event.pointerType; }}
        onFocus={event => { if (!suppressFocus.current && event.currentTarget.matches(":focus-visible")) openPopup(item.id); }}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const target = event.key === "Home" ? 0 : event.key === "End" ? railItems.length - 1
              : Math.max(0, Math.min(railItems.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
            dashRefs.current.get(railItems[target].id)?.focus();
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault(); openPopup(item.id);
            requestAnimationFrame(() => popupRef.current?.querySelector<HTMLButtonElement>(".toc-item")?.focus());
          }
        }}
        onClick={() => {
          const touch = pressType.current === "touch";
          pressType.current = "";
          if (touch && (!pinned || hoveredId !== item.id)) { openPopup(item.id); setPinned(true); return; }
          scrollTo(item); closePopup();
        }}>
        <span style={{ width: DASH_WIDTHS[Math.min(item.originalLevel - minLevel, DASH_WIDTHS.length - 1)] }} />
      </button>)}
    </div>
  </nav>;
}

export function TableOfContents(props: { editor: Editor | null; store: TocStore; numbered?: boolean }) {
  return isNativeHost() ? null : <DesktopTableOfContents {...props} />;
}
