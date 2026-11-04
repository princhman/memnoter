import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { suppressesTextInput } from "../lib/editor-input.ts";

// Enabled by the native Debug host (or the WebKit regression harness).
export function traceScroll(reason: string, details: Record<string, unknown> = {}) {
  if (!(window as Window & { __memnoterScrollDebug?: boolean }).__memnoterScrollDebug) return;
  const payload = { time: Date.now(), reason, ...details };
  console.debug("[scroll]", JSON.stringify(payload));
  (window as Window & { webkit?: { messageHandlers?: { memnoter?: { postMessage(value: unknown): void } } } }).webkit?.messageHandlers?.memnoter?.postMessage({ kind: "event", event: "scrollDebug", payload });
}

export function observeScroll(container: HTMLElement) {
  const log = () => traceScroll("scroll", { inner: container.scrollTop, document: document.scrollingElement?.scrollTop });
  container.addEventListener("scroll", log);
  document.addEventListener("scroll", log, true);
  return () => { container.removeEventListener("scroll", log); document.removeEventListener("scroll", log, true); };
}

// Native owns viewport occlusion. Never subtract visualViewport here as well.
export function revealCaret(view: EditorView, reason = "selection") {
  if (view.isDestroyed || !view.hasFocus() || suppressesTextInput(view.state.selection)) return;
  const container = view.dom.closest<HTMLElement>(".app-scroll-container");
  if (!container || anchors.has(container)) return;
  const inset = Number(container.dataset.bottomInset ?? 0);
  const caret = view.coordsAtPos(view.state.selection.head);
  const top = visibleTop(container);
  const bottom = container.getBoundingClientRect().top + container.clientTop + container.clientHeight - inset - 24;
  const delta = caret.bottom > bottom ? caret.bottom - bottom : caret.top < top ? caret.top - top : 0;
  if (Math.abs(delta) < 1) return;
  container.dispatchEvent(new Event("memnoter:reveal"));
  traceScroll("caret", { trigger: reason, from: container.scrollTop, delta });
  container.scrollTo({ top: container.scrollTop + delta,
    behavior: "instant" });
}

// One owner for section navigation, delayed layout and native inset changes.
// Settle a navigation for at most 300ms; reader input always takes priority.
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
  const container = editor.view.dom.closest<HTMLElement>(".app-scroll-container");
  if (!(heading instanceof HTMLElement) || !container) return;
  anchors.get(container)?.stop();
  container.dispatchEvent(new Event("memnoter:reveal"));
  let frame = 0;
  let deadline = 0;
  const apply = () => {
    if (editor.isDestroyed || !heading.isConnected) { stop(); return; }
    const delta = heading.getBoundingClientRect().top - visibleTop(container) - offset;
    const target = Math.max(0, container.scrollTop + delta);
    // Supply enough trailing room before clamping, even for a short last section.
    const extra = Number(container.dataset.anchorSpace ?? 0);
    const space = Math.max(0, Math.ceil(target - (container.scrollHeight - extra - container.clientHeight)));
    container.dataset.anchorSpace = String(space);
    container.style.setProperty("--anchor-space", `${space}px`);
    traceScroll("anchor", { from: container.scrollTop, target, offset });
    container.scrollTo({ top: Math.min(target, Math.max(0, container.scrollHeight - container.clientHeight)), behavior: "instant" });
  };
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(apply);
  });
  const stop = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    window.clearTimeout(deadline);
    inputEvents.forEach(event => container.removeEventListener(event, stop, true));
    anchors.delete(container);
  };
  anchors.set(container, { apply, stop });
  deadline = window.setTimeout(() => { apply(); stop(); }, 300);
  inputEvents.forEach(event => container.addEventListener(event, stop, { capture: true, passive: true }));
  observer.observe(editor.view.dom);
  observer.observe(container);
  apply();
  frame = requestAnimationFrame(() => { apply(); frame = requestAnimationFrame(apply); });
}

export function sectionOffset(editor: Editor, pos: number) {
  const heading = editor.view.nodeDOM(pos);
  const container = editor.view.dom.closest<HTMLElement>(".app-scroll-container");
  return heading instanceof HTMLElement && container ? heading.getBoundingClientRect().top - visibleTop(container) : 0;
}
