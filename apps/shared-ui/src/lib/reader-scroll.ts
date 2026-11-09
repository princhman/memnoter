import { editorHost } from "./editor-host";

// Touch release is not scroll completion: WebKit continues on the compositor
// during momentum. Only a quiet interval after the last scroll gives layout
// and automatic reveals ownership again.
const QUIET_MS = 200;
type Reading = { touching: boolean; moving: boolean; timer: number; jobs: Set<() => void> };
const readers = new WeakMap<HTMLElement, Reading>();

export function isReaderScrolling(container: HTMLElement) {
  return readers.get(container)?.moving === true;
}

export function observeReaderScroll(container: HTMLElement, takeOver: () => void) {
  const state: Reading = { touching: false, moving: false, timer: 0, jobs: new Set() };
  readers.set(container, state);
  const settle = () => {
    window.clearTimeout(state.timer);
    if (state.touching) return;
    state.timer = window.setTimeout(() => {
      state.moving = false;
      const jobs = [...state.jobs];
      state.jobs.clear();
      for (const job of jobs) job();
    }, QUIET_MS);
  };
  const move = () => { state.moving = true; takeOver(); settle(); };
  const start = () => { state.touching = true; };
  const end = () => { state.touching = false; settle(); };
  const scroll = () => { if (state.touching || state.moving) move(); };
  const edit = () => { state.touching = false; state.moving = false; settle(); };
  container.addEventListener("touchstart", start, { passive: true });
  container.addEventListener("touchmove", move, { passive: true });
  container.addEventListener("wheel", move, { passive: true });
  container.addEventListener("scroll", scroll, { passive: true });
  container.addEventListener("keydown", edit, true);
  container.addEventListener("beforeinput", edit, true);
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", end, { passive: true });
  return () => {
    window.clearTimeout(state.timer);
    state.jobs.clear();
    readers.delete(container);
    container.removeEventListener("touchstart", start);
    container.removeEventListener("touchmove", move);
    container.removeEventListener("wheel", move);
    container.removeEventListener("scroll", scroll);
    container.removeEventListener("keydown", edit, true);
    container.removeEventListener("beforeinput", edit, true);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", end);
  };
}

// A lazy renderer may finish after its block has passed above the viewport.
// Commit between gestures and preserve the following text before paint. This
// works on WK versions without CSS scroll anchoring and avoids double correction
// on engines that already anchor (measure the actual remaining drift).
export function commitViewportLayout(element: HTMLElement, update: () => void) {
  const container = editorHost.isNative ? editorHost.scrollContainer(element) : null;
  const state = container && readers.get(container);
  const commit = () => {
    if (!element.isConnected) return;
    let block = element;
    while (block.parentElement && !block.parentElement.classList.contains("tiptap")) block = block.parentElement;
    const next = block.nextElementSibling;
    const above = container && block.getBoundingClientRect().bottom <= container.getBoundingClientRect().top + Number(container.dataset.topInset ?? 0);
    const before = above && next ? next.getBoundingClientRect().top : undefined;
    update();
    if (container && next && before !== undefined) {
      const drift = next.getBoundingClientRect().top - before;
      if (Math.abs(drift) >= 1) container.scrollTop += drift;
    }
  };
  if (state?.moving) {
    state.jobs.add(commit);
    return () => { state.jobs.delete(commit); };
  }
  commit();
  return () => {};
}
