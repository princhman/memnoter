import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

// Images move by pressing on them and dragging, with pointer events rather than
// native drag and drop. Native drags swallow the click that selects an image,
// Tauri's webview can intercept their drops, and they do nothing on touch.

const THRESHOLD = 4;

// Where the node at `from` would land if dropped at document position `target`.
export function imageDropPosition(state: EditorState, from: number, target: number) {
  const node = state.doc.nodeAt(from);
  if (!node) return null;
  const insert = dropPoint(state.doc, target, new Slice(Fragment.from(node), 0, 0));
  // Dropping on or right next to itself leaves it where it is.
  if (insert === null || (insert >= from && insert <= from + node.nodeSize)) return null;
  return insert;
}

// The node keeps its attributes (asset, caption, masks) because the same node
// is reinserted; nothing passes through HTML.
export function moveImage(state: EditorState, from: number, target: number): Transaction | null {
  const node = state.doc.nodeAt(from);
  const insert = imageDropPosition(state, from, target);
  if (!node || insert === null) return null;
  const tr = state.tr.delete(from, from + node.nodeSize);
  const at = tr.mapping.map(insert);
  tr.replaceRangeWith(at, at, node);
  let moved = -1;
  tr.doc.nodesBetween(Math.max(0, at - 2), Math.min(tr.doc.content.size, at + node.nodeSize + 2), (child, pos) => {
    if (moved < 0 && child.eq(node)) moved = pos;
    return moved < 0;
  });
  if (moved >= 0) tr.setSelection(NodeSelection.create(tr.doc, moved));
  return tr.scrollIntoView();
}

function indicatorRect(view: EditorView, insert: number, inline: boolean) {
  const $pos = view.state.doc.resolve(insert);
  if (inline || $pos.parent.inlineContent) {
    const { left, top, bottom } = view.coordsAtPos(insert);
    return { left: left - 1, top, width: 2, height: bottom - top };
  }
  const editor = view.dom.getBoundingClientRect();
  const after = $pos.nodeAfter && (view.nodeDOM(insert) as HTMLElement | null);
  const before = $pos.nodeBefore && (view.nodeDOM(insert - $pos.nodeBefore.nodeSize) as HTMLElement | null);
  const y = after?.getBoundingClientRect?.().top ?? before?.getBoundingClientRect?.().bottom ?? view.coordsAtPos(insert).top;
  return { left: editor.left, top: y - 1, width: editor.width, height: 2 };
}

function autoScroll(view: EditorView, y: number) {
  const container = view.dom.closest<HTMLElement>(".app-scroll-container");
  if (!container) return;
  const { top, bottom } = container.getBoundingClientRect();
  if (y < top + 40) container.scrollTop -= 12;
  else if (y > bottom - 40) container.scrollTop += 12;
}

function stopCapturing(view: EditorView) {
  yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
}

// Begins tracking a press on an image. Below the threshold it stays a click.
// Returns a function that cancels the move (for example when the editor is
// destroyed mid-drag), removing the marker and every window listener.
export function startImagePointerMove(view: EditorView, getPos: () => number | undefined, down: PointerEvent): () => void {
  const from = getPos();
  if (from === undefined) return () => {};
  const node = view.state.doc.nodeAt(from);
  if (!node) return () => {};
  const element = view.nodeDOM(from) as HTMLElement | null;
  let moving = false;
  let insert: number | null = null;
  const indicator = document.createElement("div");
  indicator.className = "note-image-drop-indicator";

  const update = (event: PointerEvent) => {
    if (!moving) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < THRESHOLD) return;
      moving = true;
      element?.setAttribute("data-moving", "");
      document.documentElement.classList.add("is-moving-image");
      document.body.append(indicator);
    }
    autoScroll(view, event.clientY);
    const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
    const current = getPos();
    insert = target && current !== undefined ? imageDropPosition(view.state, current, target.pos) : null;
    indicator.hidden = insert === null;
    if (insert !== null) Object.assign(indicator.style, Object.fromEntries(
      Object.entries(indicatorRect(view, insert, node.isInline)).map(([key, value]) => [key, `${value}px`]),
    ));
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", update);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", escape, true);
    indicator.remove();
    element?.removeAttribute("data-moving");
    document.documentElement.classList.remove("is-moving-image");
    const current = getPos();
    if (!commit || !moving || insert === null || current === undefined || view.isDestroyed) return;
    const tr = moveImage(view.state, current, insert);
    if (!tr) return;
    // One undo step, apart from typing before or after the move.
    stopCapturing(view);
    view.dispatch(tr);
    stopCapturing(view);
    view.focus();
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !moving) return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", update);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", escape, true);
  return cancel;
}
