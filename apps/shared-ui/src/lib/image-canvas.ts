// Use a page canvas on WebKit versions without an offscreen 2D context.
export function makeImageCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) return {
      context,
      encode: (type: string, quality?: number) => canvas.convertToBlob({ type, quality }),
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not prepare the image");
  return {
    context,
    encode: (type: string, quality?: number) => new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode the image")), type, quality)),
  };
}
