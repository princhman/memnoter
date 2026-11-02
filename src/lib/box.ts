// A rectangle on an image, in fractions of its width and height, as the crop
// area and occlusion masks use it.
export type Box = { x: number; y: number; width: number; height: number };
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// Drags the edges a handle holds, keeping the box inside the image and at
// least `min` wide and high.
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number, min: number): Box {
  let left = box.x, top = box.y, right = box.x + box.width, bottom = box.y + box.height;
  if (handle.includes("w")) left = Math.max(0, Math.min(right - min, left + dx));
  if (handle.includes("e")) right = Math.min(1, Math.max(left + min, right + dx));
  if (handle.includes("n")) top = Math.max(0, Math.min(bottom - min, top + dy));
  if (handle.includes("s")) bottom = Math.min(1, Math.max(top + min, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Moves the box, stopping at the image's edges.
export function moveBox(box: Box, dx: number, dy: number): Box {
  return {
    ...box,
    x: Math.max(0, Math.min(1 - box.width, box.x + dx)),
    y: Math.max(0, Math.min(1 - box.height, box.y + dy)),
  };
}
