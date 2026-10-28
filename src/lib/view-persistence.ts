import { useEffect, useLayoutEffect } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { sectionFocusKey } from "./section-focus";
import { getFoldedIds } from "./heading-fold";
import {
  appStore,
  saveModuleView,
  setOpenedModule,
  type ModuleView,
} from "./store";

const SCROLL_CONTAINER = ".app-scroll-container";
// Images and formulas mount after the text and change the layout; hold the
// anchored block in place until the user takes over or this passes.
const ANCHOR_HOLD_MS = 3_000;
const SAVE_DELAY_MS = 150;

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

type ScrollAnchor = NonNullable<ModuleView["scrollAnchor"]>;

function viewportTop(container: HTMLElement) {
  return container.getBoundingClientRect().top + container.clientTop;
}

// Pixels shift as images and formulas load; a block position does not.
function readScrollAnchor(
  editor: Editor,
  container: HTMLElement,
): ScrollAnchor | undefined {
  const top = viewportTop(container);
  const { view } = editor;
  const { doc } = view.state;
  const box = view.dom.getBoundingClientRect();
  const y = Math.max(top, box.top) + 1;
  if (y >= box.bottom || doc.childCount === 0) return undefined;

  // Start from the block under the viewport's top edge: scanning from the
  // start of the note would measure every block above it, on every save.
  const hit = view.posAtCoords({ left: box.left + box.width / 2, top: y });
  const $hit = doc.resolve(hit?.pos ?? 0);
  const first = Math.max(0, Math.min($hit.index(0), doc.childCount - 1) - 1);

  for (let index = first; index < doc.childCount; index++) {
    const pos = $hit.posAtIndex(index, 0);
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) continue;

    const rect = dom.getBoundingClientRect();
    // Folded and out-of-focus blocks are not laid out.
    if (rect.height === 0) continue;
    if (rect.bottom > top) return { pos, offset: rect.top - top };
  }
  return undefined;
}

function anchorElement(editor: Editor, anchor: ScrollAnchor) {
  const { doc } = editor.state;
  if (anchor.pos < 0 || anchor.pos >= doc.content.size) return null;
  // Only top-level block boundaries were saved; anything else is stale.
  if (doc.resolve(anchor.pos).depth !== 0) return null;

  const dom = editor.view.nodeDOM(anchor.pos);
  return dom instanceof HTMLElement ? dom : null;
}

function restoreSelection(editor: Editor, view: ModuleView) {
  const { doc } = editor.state;
  const clamp = (pos: number) => Math.min(Math.max(pos, 0), doc.content.size);

  const tr = editor.state.tr.setSelection(
    TextSelection.between(
      doc.resolve(clamp(view.anchor)),
      doc.resolve(clamp(view.head)),
    ),
  );
  editor.view.dispatch(tr.setMeta("addToHistory", false));
}

let stopActiveRestore: (() => void) | undefined;

// Ends the hold on the restored scroll position early, for code that moves the
// view on the reader's behalf, like revealing a search match.
export function stopScrollRestore() {
  stopActiveRestore?.();
}

function restoreScroll(
  editor: Editor,
  container: HTMLElement,
  view: ModuleView,
) {
  const apply = () => {
    const element = view.scrollAnchor && anchorElement(editor, view.scrollAnchor);
    if (element && view.scrollAnchor) {
      const drift =
        element.getBoundingClientRect().top -
        viewportTop(container) -
        view.scrollAnchor.offset;
      container.scrollTop += drift;
    } else {
      container.scrollTop = view.scrollTop;
    }
  };

  // Resize callbacks run before paint, so each correction is never seen.
  const resizeObserver = new ResizeObserver(apply);

  const stop = () => {
    if (stopActiveRestore === stop) stopActiveRestore = undefined;
    resizeObserver.disconnect();
    window.clearTimeout(holdTimeout);
    for (const event of USER_SCROLL_EVENTS) {
      container.removeEventListener(event, stop);
    }
  };

  stopActiveRestore?.();
  stopActiveRestore = stop;
  apply();
  resizeObserver.observe(editor.view.dom);
  const holdTimeout = window.setTimeout(stop, ANCHOR_HOLD_MS);
  for (const event of USER_SCROLL_EVENTS) {
    container.addEventListener(event, stop, { passive: true });
  }

  return stop;
}

// Remembers the open module and, per module, the scroll position, cursor and
// focused and folded sections, then restores them when the module is opened again.
export function usePersistedView(
  editor: Editor | null,
  moduleId: string,
  isReady: boolean,
) {
  useEffect(() => {
    setOpenedModule(moduleId);
  }, [moduleId]);

  // A layout effect, so the note is never painted at the wrong position.
  useLayoutEffect(() => {
    if (!editor || !isReady) return;

    const container = editor.view.dom.closest<HTMLElement>(SCROLL_CONTAINER);
    if (!container) return;

    const saved = appStore.state.viewByModule[moduleId];
    let stopRestoring: (() => void) | undefined;

    if (saved) {
      if (saved.focusedSection != null) {
        editor.commands.showSection(saved.focusedSection);
      }
      restoreSelection(editor, saved);
      if (saved.foldedSections?.length) {
        // Views saved before folds were keyed by heading id hold positions.
        editor.commands.setFolds(
          saved.foldedSections.filter((id) => typeof id === "string"),
        );
      }
      editor.commands.focus(undefined, { scrollIntoView: false });
      stopRestoring = restoreScroll(editor, container, saved);
    } else {
      container.scrollTop = 0;
    }

    let saveTimeout: number | undefined;

    const save = () => {
      saveTimeout = undefined;
      // The editor DOM may already be gone while the module is switching.
      if (editor.isDestroyed || !editor.view.dom.isConnected) return;

      const { anchor, head } = editor.state.selection;
      saveModuleView(moduleId, {
        scrollTop: container.scrollTop,
        scrollAnchor: readScrollAnchor(editor, container),
        anchor,
        head,
        focusedSection: sectionFocusKey.getState(editor.state) ?? null,
        foldedSections: getFoldedIds(editor.state),
      });
    };

    const scheduleSave = () => {
      if (saveTimeout === undefined) {
        saveTimeout = window.setTimeout(save, SAVE_DELAY_MS);
      }
    };

    editor.on("transaction", scheduleSave);
    container.addEventListener("scroll", scheduleSave, { passive: true });

    return () => {
      stopRestoring?.();
      // Switching notes right after a change must not lose it.
      if (saveTimeout !== undefined) {
        window.clearTimeout(saveTimeout);
        save();
      }
      editor.off("transaction", scheduleSave);
      container.removeEventListener("scroll", scheduleSave);
    };
  }, [editor, isReady, moduleId]);
}
