import {
  FindAndReplace,
  FindAndReplacePluginKey,
} from "@tiptap/extension-find-and-replace";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// Matches are drawn as boxes on a layer behind the text rather than wrapped in
// spans: WebKit does not kern or shape text across an element boundary, so each
// span nudged the text around it, and it moved as the search was typed. The CSS
// Highlight API avoids spans too, but WebKit does not repaint when highlights
// are removed, so cleared matches stayed on screen.

const SCROLL_CONTAINER = ".app-scroll-container";
// Only matches near the viewport are drawn, as measuring each one costs time in
// long notes. Positions this far beyond the screen's edges count.
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

function currentMatch(view: EditorView): Match | null {
  const state = FindAndReplacePluginKey.getState(view.state);
  return state?.currentIndex == null
    ? null
    : (state.results[state.currentIndex] ?? null);
}

function draw(view: EditorView, layer: HTMLElement) {
  const results: Match[] =
    FindAndReplacePluginKey.getState(view.state)?.results ?? [];
  if (!results.length) {
    layer.replaceChildren();
    return;
  }

  const current = currentMatch(view);
  const origin = layer.getBoundingClientRect();
  const span = visibleSpan(view);
  const boxes: HTMLElement[] = [];

  for (const match of results) {
    if (match !== current && (match.to < span.from || match.from > span.to)) {
      continue;
    }
    const range = domRange(view, match);
    if (!range) continue;
    for (const rect of range.getClientRects()) {
      // Hidden (folded or out-of-focus) text has no size.
      if (rect.width === 0 || rect.height === 0) continue;
      const box = document.createElement("div");
      box.className =
        match === current ? "find-highlight find-highlight-current" : "find-highlight";
      box.style.left = `${rect.left - origin.left}px`;
      box.style.top = `${rect.top - origin.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      boxes.push(box);
    }
  }
  layer.replaceChildren(...boxes);
}

// Scrolls the current match into view, as its span used to be.
export function scrollCurrentResultIntoView(view: EditorView) {
  const current = currentMatch(view);
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
    for (const plugin of plugins) delete plugin.props.decorations;

    return [
      ...plugins,
      new Plugin({
        view(view) {
          // Sits right before the editor, in the same positioned wrapper, and
          // behind it (see .find-highlight-layer in App.css).
          const layer = document.createElement("div");
          layer.className = "find-highlight-layer";
          layer.setAttribute("aria-hidden", "true");

          let frame = 0;
          const redraw = () => {
            frame = 0;
            const parent = view.dom.parentElement;
            if (!parent || !view.dom.isConnected) return;
            if (layer.parentElement !== parent) parent.insertBefore(layer, view.dom);
            draw(view, layer);
          };
          const schedule = () => {
            if (!frame) frame = requestAnimationFrame(redraw);
          };
          const hasResults = () =>
            !!FindAndReplacePluginKey.getState(view.state)?.results.length;

          // Scrolling brings other matches near; images loading, folds and
          // section focus move text. The scroll container may not be mounted
          // yet, so scrolling is watched on the document.
          const onScroll = () => {
            if (hasResults()) schedule();
          };
          document.addEventListener("scroll", onScroll, { capture: true, passive: true });
          const resizeObserver = new ResizeObserver(() => {
            if (hasResults() || layer.childElementCount) schedule();
          });
          resizeObserver.observe(view.dom);

          return {
            update(view, previous) {
              if (
                FindAndReplacePluginKey.getState(view.state) !==
                FindAndReplacePluginKey.getState(previous)
              ) {
                // Drawn now, so a new match never shows a frame unlit.
                cancelAnimationFrame(frame);
                redraw();
              }
            },
            destroy() {
              cancelAnimationFrame(frame);
              document.removeEventListener("scroll", onScroll, { capture: true });
              resizeObserver.disconnect();
              layer.remove();
            },
          };
        },
      }),
    ];
  },
});
