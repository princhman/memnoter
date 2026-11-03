// iPadOS reports itself as a Mac ("MacIntel"), but Macs have no touch points.
export const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
