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
import { getFocusedSectionRange } from "@/lib/section-focus";

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
}: {
  editor: Editor | null;
  store: TocStore;
}) {
  const allItems = useSelector(store, (state) => state);
  // Focus changes don't touch the document, so the TOC extension won't report them.
  const focusRange = useEditorState({
    editor,
    selector: ({ editor }) => {
      const range = editor ? getFocusedSectionRange(editor.state) : null;
      return range ? `${range.from}:${range.to}` : null;
    },
  });
  const items = useMemo(() => {
    if (!focusRange) return allItems;
    const [from, to] = focusRange.split(":").map(Number);
    return allItems.filter((item) => item.pos >= from && item.pos < to);
  }, [allItems, focusRange]);
  const [hovered, setHovered] = useState<HoveredSection | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const safeAreaRef = useRef<HTMLDivElement>(null);

  // Centre the popup on the hovered dash, then clamp it inside the window.
  // Showing or hiding sections moves headings, so recompute which one is current.
  useEffect(() => {
    setHovered(null);
    // A destroyed editor (e.g. replaced during a reload) has empty storage.
    if (!editor || editor.isDestroyed) return;
    editor.storage.tableOfContents.scrollHandler();
  }, [editor, focusRange]);

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
      onPointerLeave={() => setHovered(null)}
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
              style={{
                paddingLeft: `${0.5 + (item.level - items[section.start].level) * 0.625}rem`,
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => scrollTo(item)}
            >
              <HeadingTitle node={item.node} />
            </button>
          ))}
        </div>
      )}

      <div className="toc-rail">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className="toc-dash"
            aria-label={item.textContent}
            data-active={item.id === activeId}
            data-related={
              section !== null && index >= section.start && index < section.end
            }
            onMouseDown={(event) => event.preventDefault()}
            onPointerEnter={(event) =>
              setHovered({
                start: index,
                end: getSectionEnd(items, index),
                anchor:
                  event.currentTarget.offsetTop +
                  event.currentTarget.offsetHeight / 2,
              })
            }
            onPointerMove={(event) => {
              if (section?.start === index) updateSafeArea(event);
            }}
            onClick={() => scrollTo(item)}
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
        ))}
      </div>
    </nav>
  );
}
