import {
  FindAndReplace,
  FindAndReplacePluginKey,
} from "@tiptap/extension-find-and-replace";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// Matches are painted with the CSS Custom Highlight API rather than wrapped in
// spans: WebKit does not kern or shape text across an element boundary, so each
// span nudged the text around it, and it moved as the search was typed.
const supported =
  typeof CSS !== "undefined" &&
  "highlights" in CSS &&
  typeof Highlight !== "undefined";

// Kept out of App.css: the CSS build step does not know ::highlight and drops it.
const STYLES = `
::highlight(find-result) {
  background-color: color-mix(in oklch, var(--primary) 18%, transparent);
}
::highlight(find-current) {
  background-color: color-mix(in oklch, var(--primary) 45%, transparent);
}`;

function injectStyles() {
  if (document.getElementById("find-highlight-styles")) return;
  const style = document.createElement("style");
  style.id = "find-highlight-styles";
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const SCROLL_CONTAINER = ".app-scroll-container";
// Only matches near the viewport are painted, as finding each one in the DOM
// costs time in long notes. Positions this far beyond the screen's edges count.
const SLACK = 3000;

type Match = { from: number; to: number };

function domRange(view: EditorView, { from, to }: Match): Range | null {
  try {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

// The document positions shown in the scroll container, widened by SLACK.
function visibleSpan(view: EditorView): Match {
  const size = view.state.doc.content.size;
  const container = view.dom.closest<HTMLElement>(SCROLL_CONTAINER);
  if (!container) return { from: 0, to: size };

  const box = container.getBoundingClientRect();
  const editor = view.dom.getBoundingClientRect();
  const left = editor.left + editor.width / 2;
  const top = view.posAtCoords({ left, top: Math.max(box.top, editor.top) + 1 });
  const bottom = view.posAtCoords({ left, top: Math.min(box.bottom, editor.bottom) - 1 });
  return {
    from: top ? top.pos - SLACK : 0,
    to: bottom ? bottom.pos + SLACK : size,
  };
}

function paint(view: EditorView) {
  const state = FindAndReplacePluginKey.getState(view.state);
  const results: Match[] = state?.results ?? [];
  const current =
    state?.currentIndex == null ? null : (results[state.currentIndex] ?? null);

  const others = new Highlight();
  const active = new Highlight();
  if (results.length) {
    const span = visibleSpan(view);
    for (const match of results) {
      if (match === current) continue;
      if (match.to < span.from || match.from > span.to) continue;
      const range = domRange(view, match);
      if (range) others.add(range);
    }
    const range = current && domRange(view, current);
    if (range) active.add(range);
  }
  CSS.highlights.set("find-result", others);
  CSS.highlights.set("find-current", active);
}

// Scrolls the current match into view, as its span used to be.
export function scrollCurrentResultIntoView(view: EditorView) {
  const state = FindAndReplacePluginKey.getState(view.state);
  const current =
    state?.currentIndex == null ? null : state.results[state.currentIndex];
  if (!current) return;
  const range = domRange(view, current);
  const container = view.dom.closest<HTMLElement>(SCROLL_CONTAINER);
  if (!range || !container) return;

  const rect = range.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (rect.height === 0) return;
  if (rect.top < box.top) container.scrollTop -= box.top - rect.top + 16;
  else if (rect.bottom > box.bottom) {
    container.scrollTop += rect.bottom - box.bottom + 16;
  }
}

export const FindHighlights = FindAndReplace.extend({
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? [];
    // Older WebKit keeps the extension's own span highlights.
    if (!supported) return plugins;
    for (const plugin of plugins) delete plugin.props.decorations;
    injectStyles();

    return [
      ...plugins,
      new Plugin({
        view(view) {
          let frame = 0;
          // Scrolling brings other matches near; the container may not be
          // mounted yet, so listen on the document.
          const schedule = () => {
            if (frame || !FindAndReplacePluginKey.getState(view.state)?.results.length) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              if (view.dom.isConnected) paint(view);
            });
          };
          document.addEventListener("scroll", schedule, { capture: true, passive: true });

          return {
            update(view, previous) {
              if (
                FindAndReplacePluginKey.getState(view.state) !==
                FindAndReplacePluginKey.getState(previous)
              ) {
                // Painted now, so a new match never shows a frame unlit.
                paint(view);
              }
            },
            destroy() {
              cancelAnimationFrame(frame);
              document.removeEventListener("scroll", schedule, { capture: true });
              CSS.highlights.delete("find-result");
              CSS.highlights.delete("find-current");
            },
          };
        },
      }),
    ];
  },
});
