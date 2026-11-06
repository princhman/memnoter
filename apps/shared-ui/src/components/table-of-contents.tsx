import { isNativeHost } from "@/lib/backend";
import { IconTooltip } from "@/components/icon-tooltip";
import { headingNumbers } from "@/lib/heading-numbering";
import {
  useEffect,
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
import { ChevronRight } from "lucide-react";
import { getFocusedSectionRange } from "@/lib/section-focus";
import { getFoldedRanges } from "@/lib/heading-fold";

export type TocStore = ReturnType<typeof createTocStore>;

export function createTocStore() {
  return createStore<TableOfContentData>([]);
}

// Dash width in the rail, by nesting level.
const DASH_WIDTHS = [28, 20, 14, 9];
// Keeps the popup this far from the window edges.
const VIEWPORT_MARGIN = 16;
// Keep short notes fully expanded; longer outlines start with two relative levels.
const LONG_OUTLINE_THRESHOLD = 40;
const BRANCH_HOVER_DELAY = 180;

type HoveredSection = {
  start: number;
  // Exclusive: the next heading at the same or a higher level.
  end: number;
  // Centre of the hovered dash, relative to the nav.
  anchor: number;
};

function getSectionEnd(items: TableOfContentData, start: number) {
  const level = items[start].level;
  for (let index = start + 1; index < items.length; index += 1) {
    if (items[index].level <= level) return index;
  }
  return items.length;
}

// Headings keep inline math as raw LaTeX, so render it like the editor does.
function HeadingTitle({ node }: { node: PMNode }) {
  const html = useMemo(() => {
    const parts: string[] = [];
    node.forEach((child) => {
      if (child.type.name === "inlineMath") {
        parts.push(
          katex.renderToString(child.textContent.replace(/\u200b/g, ""), {
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
  const numbers = useEditorState({ editor, selector: ({ editor }) => editor ? [...headingNumbers(editor.state.doc)] : [] });
  const numberAt = (pos: number) => numbered ? `${new Map(numbers ?? []).get(pos) ?? ""} ` : "";
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
    return allItems.filter(
      (item) =>
        (!focusRange || (item.pos >= from && item.pos < to)) &&
        !folded.some((range) => item.pos >= range.from && item.pos < range.to),
    );
  }, [allItems, focusRange, folded]);
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const branchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowAnchor = useRef<{ id: string; top: number } | null>(null);
  const longOutline = items.length > LONG_OUTLINE_THRESHOLD;
  const shallowLevels = [...new Set(items.map(item => item.level))].sort((a, b) => a - b).slice(0, 2);
  const ancestors = new Map<string, string[]>();
  const stack: TableOfContentData = [];
  for (const item of items) {
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    ancestors.set(item.id, stack.filter(parent => shallowLevels.includes(parent.level)).map(parent => parent.id));
    stack.push(item);
  }
  const activeId = [...items].reverse().find(item => item.isScrolledOver)?.id ?? items[0]?.id;
  const activeItem = items.find(item => item.id === activeId);
  const activeBranch = activeItem && shallowLevels.includes(activeItem.level)
    ? null : ancestors.get(activeId)?.slice(-1)[0];
  const visibleItems = items.filter(item => !longOutline || shallowLevels.includes(item.level) ||
    !ancestors.get(item.id)?.length ||
    ancestors.get(item.id)?.some(id => id === expandedBranch || id === activeBranch));
  const visibleIds = new Set(visibleItems.map(item => item.id));
  const parentsWithChildren = new Set<string>();
  const parentsWithHiddenChildren = new Set<string>();
  for (const item of items) {
    if (shallowLevels.includes(item.level)) continue;
    for (const parent of ancestors.get(item.id) ?? []) {
      parentsWithChildren.add(parent);
      if (!visibleIds.has(item.id)) parentsWithHiddenChildren.add(parent);
    }
  }
  const hasChildren = (item: TableOfContentDataItem) => longOutline && parentsWithChildren.has(item.id);
  const hasHiddenChildren = (item: TableOfContentDataItem) => longOutline && parentsWithHiddenChildren.has(item.id);
  const isFolded = (item: TableOfContentDataItem) =>
    folded.some((range) => range.heading === item.pos);
  const [hovered, setHovered] = useState<HoveredSection | null>(null);
  // Set while a finger opened the outline: it stays open until a tap elsewhere.
  const [pinned, setPinned] = useState(false);
  const [compact, setCompact] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The pointer that pressed a dash, so its click knows whether it was a tap.
  const pressTypeRef = useRef("");
  const navRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const safeAreaRef = useRef<HTMLDivElement>(null);

  // Centre the popup on the hovered dash, then clamp it inside the window.
  // Showing or hiding sections moves headings, so recompute which one is current.
  useEffect(() => {
    setHovered(null);
    setPinned(false);
    // A destroyed editor (e.g. replaced during a reload) has empty storage.
    if (!editor || editor.isDestroyed) return;
    editor.storage.tableOfContents.scrollHandler();
  }, [editor, focusRange, foldedRanges]);

  // A tap outside closes an outline a tap opened.
  useEffect(() => {
    if (!pinned) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && navRef.current?.contains(event.target)) return;
      setHovered(null);
      setPinned(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [pinned]);

  // Use the actual note margin, including sidebar and window size changes.
  useLayoutEffect(() => {
    if (!editor) return;
    const measure = () => {
      const nav = navRef.current;
      if (!nav) return;
      setCompact(!window.matchMedia("(pointer: coarse)").matches &&
        nav.getBoundingClientRect().left - editor.view.dom.getBoundingClientRect().right < 240);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(editor.view.dom);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [editor, items.length]);

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (branchTimer.current) clearTimeout(branchTimer.current);
  }, []);

  useLayoutEffect(() => {
    const position = () => {
      const nav = navRef.current;
      const panel = panelRef.current;
      if (!hovered || !nav || !panel) return;
      const navTop = nav.getBoundingClientRect().top;
      const content = editor?.view.dom.closest(".app-scroll-container")?.getBoundingClientRect();
      const minTop = Math.max(VIEWPORT_MARGIN, (content?.top ?? 0) + VIEWPORT_MARGIN);
      if (compact) {
        // Whole rows at rest, with padding above and below the scrollable list.
        const row = parseFloat(getComputedStyle(panel).fontSize) * 1.75;
        const available = Math.min(window.innerHeight * 0.6, window.innerHeight - minTop - VIEWPORT_MARGIN);
        const rows = Math.max(1, Math.floor((available - 16) / row));
        panel.style.height = `${Math.min(rows, longOutline ? rows : items.length) * row + 16}px`;
      } else {
        panel.style.removeProperty("height");
      }
      const height = panel.offsetHeight;
      const centred = navTop + hovered.anchor - height / 2;
      const top = Math.max(minTop, Math.min(centred, window.innerHeight - VIEWPORT_MARGIN - height));
      panel.style.top = `${top - navTop}px`;
      const current = panel.querySelector<HTMLElement>('[data-active="true"]');
      if (current) {
        // Scroll only the list, never its containing note or the window.
        panel.scrollTop = current.offsetTop - panel.clientHeight / 2 + current.offsetHeight / 2;
      }
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [hovered, compact, editor, items]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = rowAnchor.current;
    rowAnchor.current = null;
    if (!panel) return;
    if (!anchor) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && panel.contains(focused)) {
        const rect = focused.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        if (rect.top < bounds.top + 8 || rect.bottom > bounds.bottom - 8) panel.scrollTop = focused.offsetTop - 8;
      }
      return;
    }
    const row = panel.querySelector<HTMLElement>(`[data-toc-entry="${CSS.escape(anchor.id)}"]`);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - anchor.top;
    const desired = panel.scrollTop + delta;
    if (desired < 0) {
      // Retain scrollable space above the pointer while an earlier branch closes.
      panel.style.paddingTop = `${parseFloat(getComputedStyle(panel).paddingTop) - desired}px`;
    }
    panel.scrollTop = Math.max(0, desired);
  }, [expandedBranch]);

  if (!editor || items.length === 0) return null;

  const minLevel = Math.min(...items.map((item) => item.level));
  // The hovered index can outlive an edit that removed headings.
  const section =
    hovered && hovered.start < items.length
      ? { ...hovered, start: compact || longOutline ? 0 : hovered.start, end: compact || longOutline ? items.length : Math.min(hovered.end, items.length) }
      : null;

  // Stretches an invisible triangle from the pointer to the popup's edge. It sits
  // above the rail, so heading for the popup diagonally neither hovers other
  // dashes nor leaves the nav.
  function updateSafeArea(event: React.PointerEvent) {
    const nav = navRef.current;
    const panel = panelRef.current;
    const area = safeAreaRef.current;
    if (!nav || !panel || !area) return;

    const navRect = nav.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const top = Math.min(panelRect.top, event.clientY);
    const bottom = Math.max(panelRect.bottom, event.clientY);
    const width = event.clientX - panelRect.right;
    area.style.left = `${panelRect.right - navRect.left}px`;
    area.style.top = `${top - navRect.top}px`;
    area.style.width = `${Math.max(width, 0)}px`;
    area.style.height = `${bottom - top}px`;
    area.style.clipPath = `polygon(${width}px ${event.clientY - top}px, 0 ${panelRect.top - top}px, 0 ${panelRect.bottom - top}px)`;
  }

  function openSection(index: number, dash: HTMLElement) {
    setHovered({
      start: index,
      end: getSectionEnd(items, index),
      anchor: dash.offsetTop + dash.offsetHeight / 2,
    });
  }

  function revealBranch(item: TableOfContentDataItem, row: HTMLElement, preservePointer = false) {
    if (!longOutline) return;
    const branch = shallowLevels.includes(item.level) ? item.id : ancestors.get(item.id)?.slice(-1)[0] ?? null;
    if (branch === expandedBranch) return;
    if (panelRef.current) panelRef.current.style.scrollSnapType = "none";
    rowAnchor.current = preservePointer ? { id: item.id, top: row.getBoundingClientRect().top } : null;
    setExpandedBranch(branch ?? null);
  }

  function closeOutline() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (branchTimer.current) clearTimeout(branchTimer.current);
    setHovered(null);
    setPinned(false);
    setExpandedBranch(null);
  }

  function scrollTo(item: TableOfContentDataItem) {
    // The stored DOM node can be replaced by a re-render, so look it up fresh.
    const heading =
      editor?.view.dom.querySelector<HTMLElement>(
        `[data-toc-id="${CSS.escape(item.id)}"]`,
      ) ?? item.dom;
    heading.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav
      ref={navRef}
      className="toc"
      data-compact={compact}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeOutline();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeOutline();
      }}
      aria-label="Table of contents"
      onPointerEnter={() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
      }}
      onPointerLeave={(event) => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        if (event.pointerType !== "touch" && !pinned && !navRef.current?.contains(document.activeElement)) {
          if (compact) closeTimer.current = setTimeout(closeOutline, 120);
          else closeOutline();
        }
      }}
    >
      {section && (
        // Keyed so a new section starts without the previous dash's triangle.
        <div key={section.start} ref={safeAreaRef} className="toc-safe-area" />
      )}
      {section && (
        <div ref={panelRef} className="toc-panel"
          aria-label="Outline headings"
          onWheel={(event) => {
            event.currentTarget.style.removeProperty("scroll-snap-type");
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const pageSize = Math.max(1, Math.floor(event.currentTarget.clientHeight / (buttons[0]?.offsetHeight || 28)) - 1);
            const target = event.key === "PageDown" ? Math.min(index + pageSize, buttons.length - 1)
              : event.key === "PageUp" ? Math.max(index - pageSize, 0)
              : event.key === "End" ? buttons.length - 1 : event.key === "Home" ? 0
              : event.key === "ArrowDown" ? Math.min(index + 1, buttons.length - 1)
              : event.key === "ArrowUp" ? Math.max(index - 1, 0) : null;
            if (target !== null) {
              event.preventDefault();
              buttons[target]?.focus({ preventScroll: true });
              const button = buttons[target];
              if (button) panelRef.current!.scrollTop = button.offsetTop - 8;
            }
          }}>

          {items.slice(section.start, section.end).filter(item => visibleIds.has(item.id)).map((item) => (
            <button
              key={item.id}
              type="button"
              className="toc-item"
              title={numberAt(item.pos) + item.textContent}
              aria-label={numberAt(item.pos) + item.textContent}
              data-toc-entry={item.id}
              aria-expanded={hasChildren(item) ? !hasHiddenChildren(item) : undefined}
              onPointerEnter={(event) => {
                if (event.pointerType === "touch" || !longOutline) return;
                if (branchTimer.current) clearTimeout(branchTimer.current);
                const row = event.currentTarget;
                branchTimer.current = setTimeout(() => revealBranch(item, row, true), BRANCH_HOVER_DELAY);
              }}
              onPointerLeave={() => {
                if (branchTimer.current) clearTimeout(branchTimer.current);
              }}
              onFocus={(event) => revealBranch(item, event.currentTarget)}
              data-active={item.id === activeId}
              data-folded={isFolded(item)}
              style={{
                paddingLeft: `${0.5 + (item.level - items[section.start].level) * 0.625}rem`,
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                revealBranch(item, event.currentTarget);
                scrollTo(item);
                if (pinned && !hasChildren(item)) closeOutline();
              }}
            >
              <span className="toc-item-title">
                {numberAt(item.pos)}<HeadingTitle node={item.node} />
              </span>
              {hasChildren(item) && <ChevronRight className="toc-disclosure" data-expanded={!hasHiddenChildren(item)} aria-label={hasHiddenChildren(item) ? "More headings" : "Expanded headings"} />}
              {isFolded(item) && <ChevronRight aria-label="Folded" />}
            </button>
          ))}
        </div>
      )}

      <div className="toc-rail">
        {visibleItems.map((item) => {
          const index = items.indexOf(item);
          return (
          <IconTooltip key={item.id} disabled={compact} label={numberAt(item.pos) + item.textContent} side="left">
          <button
            type="button"
            className="toc-dash"
            aria-label={numberAt(item.pos) + item.textContent}
            data-active={item.id === activeId}
            data-folded={isFolded(item)}
            data-related={
              section !== null && index >= section.start && index < section.end
            }
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              pressTypeRef.current = event.pointerType;
            }}
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch" && !pinned) {
                if (hoverTimer.current) clearTimeout(hoverTimer.current);
                const dash = event.currentTarget;
                if (compact) hoverTimer.current = setTimeout(() => openSection(index, dash), 180);
                else openSection(index, dash);
              }
            }}
            onPointerLeave={() => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current);
            }}
            onFocus={(event) => {
              if (event.currentTarget.matches(":focus-visible")) openSection(index, event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                (panelRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]') ?? panelRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
              }
            }}
            onPointerMove={(event) => {
              if (event.pointerType !== "touch" && (compact || section?.start === index)) {
                updateSafeArea(event);
              }
            }}
            onClick={(event) => {
              // A finger can't hover, so its first tap opens the outline,
              // and a second tap on the same dash goes to that heading.
              const tapped = pressTypeRef.current === "touch";
              pressTypeRef.current = "";
              if (tapped && section?.start !== index) {
                openSection(index, event.currentTarget);
                setPinned(true);
                return;
              }
              scrollTo(item);
              if (pinned) closeOutline();
            }}
          >
            <span
              style={{
                width:
                  DASH_WIDTHS[
                    Math.min(item.level - minLevel, DASH_WIDTHS.length - 1)
                  ],
              }}
            />
          </button>
          </IconTooltip>
          );
        })}
      </div>
    </nav>
  );
}

export function TableOfContents(props: { editor: Editor | null; store: TocStore; numbered?: boolean }) {
  return isNativeHost() ? null : <DesktopTableOfContents {...props} />;
}
