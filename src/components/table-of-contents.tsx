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

export function TableOfContents({
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
  const isFolded = (item: TableOfContentDataItem) =>
    folded.some((range) => range.heading === item.pos);
  const [hovered, setHovered] = useState<HoveredSection | null>(null);
  // Set while a finger opened the outline: it stays open until a tap elsewhere.
  const [pinned, setPinned] = useState(false);
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

  useLayoutEffect(() => {
    const nav = navRef.current;
    const panel = panelRef.current;
    if (!hovered || !nav || !panel) return;

    const navTop = nav.getBoundingClientRect().top;
    const height = panel.offsetHeight;
    const centred = navTop + hovered.anchor - height / 2;
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(centred, window.innerHeight - VIEWPORT_MARGIN - height),
    );
    panel.style.top = `${top - navTop}px`;
  }, [hovered]);

  if (!editor || items.length === 0) return null;

  // Hidden headings report as scrolled over, so pick the last visible one that is.
  // Nothing is scrolled over at the very top, so fall back to the first heading.
  const activeId =
    [...items].reverse().find((item) => item.isScrolledOver)?.id ??
    items[0].id;
  const minLevel = Math.min(...items.map((item) => item.level));
  // The hovered index can outlive an edit that removed headings.
  const section =
    hovered && hovered.start < items.length
      ? { ...hovered, end: Math.min(hovered.end, items.length) }
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

  function closeOutline() {
    setHovered(null);
    setPinned(false);
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
      aria-label="Table of contents"
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch" && !pinned) setHovered(null);
      }}
    >
      {section && (
        // Keyed so a new section starts without the previous dash's triangle.
        <div key={section.start} ref={safeAreaRef} className="toc-safe-area" />
      )}
      {section && (
        <div ref={panelRef} className="toc-panel">
          {items.slice(section.start, section.end).map((item) => (
            <button
              key={item.id}
              type="button"
              className="toc-item"
              data-active={item.id === activeId}
              data-folded={isFolded(item)}
              style={{
                paddingLeft: `${0.5 + (item.level - items[section.start].level) * 0.625}rem`,
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                scrollTo(item);
                if (pinned) closeOutline();
              }}
            >
              <span className="toc-item-title">
                {numberAt(item.pos)}<HeadingTitle node={item.node} />
              </span>
              {isFolded(item) && <ChevronRight aria-label="Folded" />}
            </button>
          ))}
        </div>
      )}

      <div className="toc-rail">
        {items.map((item, index) => (
          <IconTooltip key={item.id} label={numberAt(item.pos) + item.textContent} side="left">
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
                openSection(index, event.currentTarget);
              }
            }}
            onPointerMove={(event) => {
              if (event.pointerType !== "touch" && section?.start === index) {
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
        ))}
      </div>
    </nav>
  );
}
