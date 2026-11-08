import { beginHostNavigation, editorHost } from "@/lib/editor-host";
import { postNativeEvent } from "../lib/backend.ts";
import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { suppressesTextInput } from "../lib/editor-input.ts";

// Enabled by the native Debug host (or the WebKit regression harness).
export function traceScroll(reason: string, details: Record<string, unknown> = {}) {
  if (!(window as Window & { __memnoterScrollDebug?: boolean }).__memnoterScrollDebug) return;
  const payload = { time: Date.now(), reason, ...details };
  console.debug("[scroll]", JSON.stringify(payload));
  postNativeEvent("scrollDebug", payload);
}

export function observeScroll(container: HTMLElement) {
  const log = () => {
    traceScroll("scroll", { inner: container.scrollTop, document: document.scrollingElement?.scrollTop });
    // iOS selection reveal can scroll the document even with overflow:hidden
    // and native scroll gestures disabled. Only the inner editor may scroll.
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  container.addEventListener("scroll", log);
  document.addEventListener("scroll", log, true);
  return () => { container.removeEventListener("scroll", log); document.removeEventListener("scroll", log, true); };
}

// Native owns viewport occlusion. Never subtract visualViewport here as well.
export function revealCaret(view: EditorView, reason = "selection") {
  if (view.isDestroyed || !view.hasFocus() || suppressesTextInput(view.state.selection)) return;
  const container = editorHost.scrollContainer(view.dom);
  if (!container || anchors.has(container)) return;
  const inset = Number(container.dataset.bottomInset ?? 0);
  const caret = view.coordsAtPos(view.state.selection.head);
  const top = visibleTop(container);
  const bottom = container.getBoundingClientRect().top + container.clientTop + container.clientHeight - inset;
  if (bottom <= top) return;
  // A caret below the visible editor moves to its middle. One above it moves
  // just into view, except while typing: WebKit's layout is still settling then.
  const delta = caret.bottom > bottom ? (caret.top + caret.bottom) / 2 - (top + bottom) / 2
    : caret.top < top && reason !== "input" ? caret.top - top : 0;
  if (Math.abs(delta) < 1) return;
  beginHostNavigation(container);
  traceScroll("caret", { trigger: reason, from: container.scrollTop, delta });
  container.scrollTo({ top: Math.max(0, Math.min(container.scrollTop + delta, container.scrollHeight - container.clientHeight)),
    behavior: "instant" });
}

// One owner for section navigation, delayed layout and native inset changes.
// Observe layout until reader input or the next navigation takes priority.
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
  if (!(heading instanceof HTMLElement) || !container) return;
  anchors.get(container)?.stop();
  beginHostNavigation(container);
  let frame = 0;
  let resizeFrame = 0;
  let stableFrames = 0;
  let assetsReady = false;
  let stopped = false;
  const apply = () => {
    if (editor.isDestroyed || !heading.isConnected) { stop(); return; }
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
    stableFrames = 0;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; apply(); });
  });
  const stop = () => {
    stopped = true;
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
  const assets = [...editor.view.dom.querySelectorAll("img")].map(image => image.decode());
  void Promise.allSettled([...assets, document.fonts.ready]).then(() => { assetsReady = true; });
  const settle = () => {
    if (stopped) return;
    if (assetsReady && !resizeFrame && ++stableFrames >= 2) { stop(); return; }
    frame = requestAnimationFrame(settle);
  };
  frame = requestAnimationFrame(settle);
}

export function sectionOffset(editor: Editor, pos: number) {
  const heading = editor.view.nodeDOM(pos);
  const container = editorHost.scrollContainer(editor.view.dom);
  return heading instanceof HTMLElement && container ? heading.getBoundingClientRect().top - visibleTop(container) : 0;
}
