export const IS_APPLE = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform + navigator.userAgent);

// iPadOS reports itself as a Mac ("MacIntel"), but Macs have no touch points.
export const IS_IOS =
  typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export const IS_MAC = IS_APPLE && !IS_IOS;

// A finger, not a mouse or trackpad, is the main way to point: there is no
// hover, so controls that only appear on hover need another way to show up.
export function isCoarsePointer() {
  return window.matchMedia("(pointer: coarse)").matches;
}

// iOS keeps the page full height under the on-screen keyboard and scrolls the
// whole page to show the caret, pushing the sidebar and header off screen.
// Instead, fit the app into the visible area above the keyboard and keep the
// page itself unscrolled; the note scrolls inside its own container.
export function fitToVisibleViewport() {
  const viewport = window.visualViewport;
  if (!IS_IOS || !viewport) return;
  const root = document.documentElement;
  const sync = () => {
    root.style.height = `${viewport.height}px`;
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  sync();
}
