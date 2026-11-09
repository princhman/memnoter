import { beginHostNavigation, editorHost } from "@/lib/editor-host";
import { postNativeEvent } from "../lib/backend.ts";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { suppressesTextInput } from "../lib/editor-input.ts";

import { isReaderScrolling, observeReaderScroll } from "../lib/reader-scroll";

const selecting = new WeakSet<HTMLElement>();
const insetReveals = new WeakMap<HTMLElement, { timer: number; inputScroll?: number }>();

function cancelInsetReveal(container: HTMLElement) {
  window.clearTimeout(insetReveals.get(container)?.timer);
  insetReveals.delete(container);
}

// Enabled by the native Debug host (or the WebKit regression harness).
export function traceScroll(reason: string, details: Record<string, unknown> = {}) {
  if (!(window as Window & { __memnoterScrollDebug?: boolean }).__memnoterScrollDebug) return;
  const payload = { time: Date.now(), reason, ...details };
  console.debug("[scroll]", JSON.stringify(payload));
  postNativeEvent("scrollDebug", payload);
}

export function observeScroll(container: HTMLElement) {
  const stopReading = observeReaderScroll(container, () => {
    cancelInsetReveal(container);
    anchors.get(container)?.stop();
  });
  const log = () => {
    traceScroll("scroll", { inner: container.scrollTop, document: document.scrollingElement?.scrollTop });
    // iOS selection reveal can scroll the document even with overflow:hidden
    // and native scroll gestures disabled. Only the inner editor may scroll.
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    // WebKit may also pan the overflow-hidden note to reveal a wide cell.
    // Horizontal movement belongs exclusively to its nested media/table viewport.
    if (container.scrollLeft !== 0) container.scrollLeft = 0;
  };
  container.addEventListener("scroll", log);
  document.addEventListener("scroll", log, true);
  // Focus/inset notifications can arrive before WebKit has placed the new
  // selection. Never reveal the previous caret during a selection gesture.
  const start = () => { selecting.add(container); };
  const end = (event: Event) => {
    // iOS focuses after touch pointerup, then resolves the caret during the
    // compatibility mouse/click sequence. Keep the old caret locked out until
    // that sequence completes; a cancelled touch is a reader pan instead.
    if (event instanceof PointerEvent && event.type === "pointerup" && event.pointerType === "touch") return;
    selecting.delete(container);
  };
  container.addEventListener("pointerdown", start, true);
  document.addEventListener("pointerup", end, true);
  document.addEventListener("click", end, true);
  document.addEventListener("pointercancel", end, true);
  return () => {
    container.removeEventListener("scroll", log);
    document.removeEventListener("scroll", log, true);
    container.removeEventListener("pointerdown", start, true);
    document.removeEventListener("pointerup", end, true);
    document.removeEventListener("click", end, true);
    document.removeEventListener("pointercancel", end, true);
    stopReading();
    selecting.delete(container);
    cancelInsetReveal(container);
  };
}

// Native owns viewport occlusion. Never subtract visualViewport here as well.
export function revealCaret(view: EditorView, reason = "selection", inputScroll?: number) {
  const insertion = reason === "insertion";
  if (view.isDestroyed) return;
  // PDF selection/insertion must never move the covered note or summon input.
  if (view.dom.closest('[data-covering-note="true"]')) return;
  const container = editorHost.scrollContainer(view.dom);
  if (!container || isReaderScrolling(container)) return;
  // Insets can arrive over several keyboard/bar animation frames. Measure the
  // live endpoint once the burst is quiet, never once per intermediate frame.
  // This is independent of the bounded section-navigation settle window.
  const pending = insetReveals.get(container);
  if (reason === "inset") {
    window.clearTimeout(pending?.timer);
    const next = { timer: 0, inputScroll: pending?.inputScroll };
    next.timer = window.setTimeout(() => {
      insetReveals.delete(container);
      revealCaret(view, "settled-inset", next.inputScroll);
    }, 100);
    insetReveals.set(container, next);
    return;
  }
  if (pending && !insertion) {
    pending.inputScroll ??= inputScroll;
    return;
  }
  if (!insertion && selecting.has(container)) return;
  if (insertion) {
    cancelInsetReveal(container);
    anchors.get(container)?.stop();
    beginHostNavigation(container);
  } else if (anchors.has(container)) return;
  const inset = Number(container.dataset.bottomInset ?? 0);
  const selection = view.dom.ownerDocument.getSelection();
  const nativeRange = !insertion && selection?.rangeCount === 1
    && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)
    ? selection.getRangeAt(0) : null;
  const textSelection = nativeRange && !nativeRange.collapsed;
  if (!insertion && !textSelection && (!view.hasFocus() || suppressesTextInput(view.state.selection))) return;
  // The DOM range is authoritative during iOS word selection: ProseMirror's
  // selectionUpdate may trail keyboard/layout notifications. Never substitute
  // an old model head (often at the note end) for a missing native selection.
  if (!insertion && !nativeRange) return;
  const insertionNode = insertion ? view.domAtPos(view.state.selection.head).node : null;
  const insertionElement = insertionNode instanceof Element ? insertionNode : insertionNode?.parentElement;
  const selectedNode = insertion && view.state.selection instanceof NodeSelection
    ? view.nodeDOM(view.state.selection.from) : insertionElement?.closest(".node-pdfTextQuote");
  // Undo WebKit's unsolicited input reveal before measuring. This manager
  // alone chooses the resulting position, including Enter/paste/IME reflow.
  if (inputScroll !== undefined && nativeRange?.collapsed) container.scrollTop = inputScroll;
  const clearance = 24;
  const top = visibleTop(container) + clearance;
  const bottom = container.getBoundingClientRect().top + container.clientTop + container.clientHeight - inset - clearance;
  if (bottom <= top) return;
  let caret;
  if (textSelection) {
    const rects = Array.from(nativeRange.getClientRects()).filter(rect => rect.height > 0 && Number.isFinite(rect.top) && Number.isFinite(rect.bottom));
    if (!rects.length) return;
    const first = rects[0];
    const last = rects[rects.length - 1];
    // Drag handles own the moving endpoint. Revealing the other end of a
    // range would pull a visible selection away from the reader.
    const backwards = selection!.focusNode === nativeRange.startContainer && selection!.focusOffset === nativeRange.startOffset;
    caret = backwards ? first : last;
  } else if (insertion) {
    caret = selectedNode instanceof HTMLElement ? selectedNode.getBoundingClientRect() : view.coordsAtPos(view.state.selection.head);
  } else {
    // A collapsed DOM range can have no box in WebKit. Only use model caret
    // geometry after verifying that it describes the same DOM position.
    if (view.posAtDOM(selection!.focusNode!, selection!.focusOffset) !== view.state.selection.head) return;
    caret = view.coordsAtPos(view.state.selection.head);
  }
  if (!Number.isFinite(caret.top) || !Number.isFinite(caret.bottom) || caret.bottom <= caret.top) return;
  // Reveal only the hidden edge; typing, insets and insertion share the same
  // immediate rule. A large inserted node exposes its start without oscillating.
  const delta = caret.bottom - caret.top > bottom - top ? caret.top - top
    : caret.bottom > bottom ? caret.bottom - bottom : caret.top < top ? caret.top - top : 0;
  if (Math.abs(delta) < 1) return;
  beginHostNavigation(container);
  traceScroll("caret", { trigger: reason, from: container.scrollTop, delta });
  container.scrollTo({ top: Math.max(0, Math.min(container.scrollTop + delta, container.scrollHeight - container.clientHeight)),
    behavior: "instant" });
}

// One owner for section navigation, delayed layout and native inset changes.
// Settle navigation for at most 300ms; reader input always takes priority.
const anchors = new WeakMap<HTMLElement, { apply(): void; stop(): void }>();
const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown", "beforeinput"];

function visibleTop(container: HTMLElement) {
  return container.getBoundingClientRect().top + container.clientTop + Number(container.dataset.topInset ?? 0);
}

export function hasSectionAnchor(container: HTMLElement) {
  return anchors.has(container);
}

export function sectionToTop(editor: Editor, pos: number, offset = 0) {
  if (typeof window === "undefined") return;
  const heading = editor.view.nodeDOM(pos);
  const container = editorHost.scrollContainer(editor.view.dom);
  if (!(heading instanceof HTMLElement) || !container || isReaderScrolling(container)) return;
  anchors.get(container)?.stop();
  beginHostNavigation(container);
  let frame = 0;
  let resizeFrame = 0;
  let deadline = 0;
  const apply = () => {
    if (editor.isDestroyed || !heading.isConnected || isReaderScrolling(container)) { stop(); return; }
    const delta = heading.getBoundingClientRect().top - visibleTop(container) - offset;
    const target = Math.max(0, container.scrollTop + delta);
    // Supply enough trailing room before clamping, even for a short last section.
    // scrollHeight is at least clientHeight, even when the entire note is
    // shorter. Measure the actual content bottom so unfocus adds the missing
    // room in one layout, rather than inching toward it on resize frames.
    const extra = Number(container.dataset.anchorSpace ?? 0);
    const padding = parseFloat(getComputedStyle(container).paddingBottom) - extra;
    const contentBottom = editor.view.dom.getBoundingClientRect().bottom
      - container.getBoundingClientRect().top - container.clientTop + container.scrollTop;
    const space = Math.max(0, Math.ceil(target + container.clientHeight - contentBottom - padding));
    container.dataset.anchorSpace = String(space);
    container.style.setProperty("--anchor-space", `${space}px`);
    traceScroll("anchor", { from: container.scrollTop, target, offset });
    container.scrollTo({ top: Math.min(target, Math.max(0, container.scrollHeight - container.clientHeight)), behavior: "instant" });
  };
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; apply(); });
  });
  const stop = () => {
    window.clearTimeout(deadline);
    editor.off("destroy", stop);
    observer.disconnect();
    cancelAnimationFrame(frame);
    cancelAnimationFrame(resizeFrame);
    inputEvents.forEach(event => container.removeEventListener(event, stop, true));
    anchors.delete(container);
  };
  editor.on("destroy", stop);
  anchors.set(container, { apply, stop });
  inputEvents.forEach(event => container.addEventListener(event, stop, { capture: true, passive: true }));
  observer.observe(editor.view.dom);
  observer.observe(container);
  apply();
  deadline = window.setTimeout(() => { apply(); stop(); }, 300);
  frame = requestAnimationFrame(() => { apply(); frame = requestAnimationFrame(apply); });
}

export function sectionOffset(editor: Editor, pos: number) {
  const heading = editor.view.nodeDOM(pos);
  const container = editorHost.scrollContainer(editor.view.dom);
  return heading instanceof HTMLElement && container ? heading.getBoundingClientRect().top - visibleTop(container) : 0;
}
