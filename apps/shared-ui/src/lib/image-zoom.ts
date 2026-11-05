export type Zoom = { scale: number; x: number; y: number };
export type Point = { x: number; y: number };
export type ImageBounds = { width: number; height: number; imageWidth: number; imageHeight: number };
export const FIT: Zoom = { scale: 1, x: 0, y: 0 };

export function clampZoom(zoom: Zoom, bounds: ImageBounds): Zoom {
  const scale = Math.max(1, Math.min(5, zoom.scale));
  const limitX = Math.max(0, (bounds.imageWidth * scale - bounds.width) / 2);
  const limitY = Math.max(0, (bounds.imageHeight * scale - bounds.height) / 2);
  return { scale, x: Math.max(-limitX, Math.min(limitX, zoom.x)), y: Math.max(-limitY, Math.min(limitY, zoom.y)) };
}

// Points are relative to the viewport centre. Keep the image point under the
// fingers fixed while allowing the pinch centre to move at the same time.
export function zoomAround(zoom: Zoom, from: Point, to: Point, scale: number, bounds: ImageBounds): Zoom {
  const next = Math.max(1, Math.min(5, scale));
  const ratio = next / zoom.scale;
  return clampZoom({ scale: next, x: to.x - (from.x - zoom.x) * ratio, y: to.y - (from.y - zoom.y) * ratio }, bounds);
}
