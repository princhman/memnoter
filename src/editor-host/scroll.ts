import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { suppressesTextInput } from "../lib/editor-input";
import { stopScrollRestore } from "../lib/view-persistence";

// Native owns viewport occlusion. Never subtract visualViewport here as well.
export function revealCaret(view: EditorView) {
  if (view.isDestroyed || suppressesTextInput(view.state.selection)) return;
  const container = view.dom.closest<HTMLElement>(".app-scroll-container");
  if (!container) return;
  const inset = Number(container.dataset.bottomInset ?? 0);
  const caret = view.coordsAtPos(view.state.selection.head);
  const top = container.getBoundingClientRect().top + container.clientTop;
  const bottom = top + container.clientHeight - inset - 24;
  const delta = caret.bottom > bottom ? caret.bottom - bottom : caret.top < top ? caret.top - top : 0;
  if (Math.abs(delta) < 1) return;
  stopScrollRestore();
  container.scrollTo({ top: container.scrollTop + delta,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
}

export function sectionToTop(editor: Editor, pos: number) {
  const heading = editor.view.nodeDOM(pos);
  const container = editor.view.dom.closest<HTMLElement>(".app-scroll-container");
  if (!(heading instanceof HTMLElement) || !container) return;
  stopScrollRestore();
  container.scrollTop += heading.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
}
