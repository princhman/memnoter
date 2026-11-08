import { editorHost } from "@/lib/editor-host";
import { outline } from "./outline.ts";
import { useEffect, useLayoutEffect } from "react";
import { onHostNavigation } from "./editor-host";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { sectionFocusKey } from "./section-focus";
import { getFoldedIds } from "./heading-fold";
import {
  appStore,
  clearModuleView,
  saveModuleView,
  saveState,
  setOpenedModule,
  type ModuleView,
} from "./store";

// Images and formulas mount after the text and change the layout; hold the
// anchored block in place until the user navigates or takes over.
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
  onFailure: () => void,
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
  const resizeObserver = new ResizeObserver(() => {
    try { apply(); }
    catch (error) {
      stop();
      console.warn("Ignoring saved scroll anchor:", error);
      onFailure();
    }
  });

  const stop = () => {
    if (stopActiveRestore === stop) stopActiveRestore = undefined;
    stopNavigation();
    resizeObserver.disconnect();
    for (const event of USER_SCROLL_EVENTS) {
      container.removeEventListener(event, stop);
    }
  };

  const stopNavigation = onHostNavigation(container, stop);
  stopActiveRestore?.();
  stopActiveRestore = stop;
  try {
    apply();
    resizeObserver.observe(editor.view.dom);
  } catch (error) {
    stop();
    throw error;
  }
  for (const event of USER_SCROLL_EVENTS) {
    container.addEventListener(event, stop, { passive: true });
  }

  return stop;
}

// Stops holding each restored editor's scroll position.
const activeSaves = new Map<Editor, () => void>();

// Native calls this before switching notes or suspending JavaScript.
export function flushPersistedViews() {
  for (const save of activeSaves.values()) save();
  saveState();
}

const restoredViews = new WeakMap<Editor, (() => void) | undefined>();

// Puts back the module's saved scroll position, cursor and focused and folded
// sections, once per editor. Call it in the task that fills the editor, so the
// note is first painted the way it was left.
export function restoreView(editor: Editor, moduleId: string) {
  if (editor.isDestroyed || restoredViews.has(editor)) return;

  const container = editorHost.scrollContainer(editor.view.dom);
  if (!container) return;

  const saved = appStore.state.viewByModule[moduleId];
  let stopRestoring: (() => void) | undefined;

  const discard = () => {
    stopRestoring?.();
    clearModuleView(moduleId);
    editor.commands.showDocument();
    editor.commands.setFolds([]);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)).setMeta("addToHistory", false));
    container.scrollTop = 0;
  };

  try {
    if (saved) {
      const { doc } = editor.state;
      const position = (value: number) => Number.isInteger(value) && value >= 0 && value <= doc.content.size;
      const headingIds = new Set(outline(doc).map(heading => heading.id));
      if (!position(saved.anchor) || !position(saved.head) ||
          !Number.isFinite(saved.scrollTop) || saved.scrollTop < 0 ||
          (saved.scrollAnchor && (!position(saved.scrollAnchor.pos) || !Number.isFinite(saved.scrollAnchor.offset))) ||
          (saved.focusedSection != null && (!position(saved.focusedSection) || doc.nodeAt(saved.focusedSection)?.type.name !== "heading")) ||
          (saved.foldedSections != null && (!Array.isArray(saved.foldedSections) || saved.foldedSections.some(id => !headingIds.has(id))))) {
        discard();
      } else {
        if (saved.focusedSection != null) editor.commands.showSection(saved.focusedSection);
        restoreSelection(editor, saved);
        editor.commands.setFolds(saved.foldedSections ?? []);
        // A restored caret must not summon the keyboard on launch. Tapping the
        // editor is the user's decision to begin editing.
        if (editorHost.restoreFocus) editor.commands.focus(undefined, { scrollIntoView: false });
        stopRestoring = restoreScroll(editor, container, saved, discard);
      }
    } else {
      container.scrollTop = 0;
    }
  } catch (error) {
    console.warn("Ignoring saved editor view:", error);
    discard();
  }
  restoredViews.set(editor, stopRestoring);
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

    const container = editorHost.scrollContainer(editor.view.dom);
    if (!container) return;

    // Loading usually restored it already.
    restoreView(editor, moduleId);

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

    const saveNow = () => {
      window.clearTimeout(saveTimeout);
      save();
    };
    activeSaves.set(editor, saveNow);

    const scheduleSave = () => {
      if (saveTimeout === undefined) {
        saveTimeout = window.setTimeout(save, SAVE_DELAY_MS);
      }
    };

    editor.on("transaction", scheduleSave);
    container.addEventListener("scroll", scheduleSave, { passive: true });

    return () => {
      activeSaves.delete(editor);
      restoredViews.get(editor)?.();
      // A rerun of this effect for the same editor restores again.
      restoredViews.delete(editor);
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
