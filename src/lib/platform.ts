// iPadOS reports itself as a Mac ("MacIntel"), but Macs have no touch points.
export const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// A finger, not a mouse or trackpad, is the main way to point: there is no
// hover, so controls that only appear on hover need another way to show up.
const coarsePointer = window.matchMedia("(pointer: coarse)");

export function isCoarsePointer() {
  return coarsePointer.matches;
}
