export type AnkiLabel = { text: string; x: number; y: number; size: number; color: string; baseline?: "top" | "alphabetic" };

/** Labels are flattened only on the note-specific copy, never on a shared source. */
export async function bakeAnkiLabels(bytes: number[], mime: string, labels: AnkiLabel[], warn: (message: string) => void): Promise<{ bytes: number[]; mimeType: string }> {
  if (!labels.length) return { bytes, mimeType: mime };
  try {
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
      const context = canvas.getContext("2d");
      if (!context || !("drawImage" in context)) throw new Error("No 2D canvas");
      context.drawImage(bitmap, 0, 0);
      for (const label of labels) {
        context.font = `${label.size * bitmap.height}px sans-serif`;
        context.fillStyle = label.color;
        context.textBaseline = label.baseline ?? "alphabetic";
        context.fillText(label.text, label.x * bitmap.width, label.y * bitmap.height);
      }
      const output = "convertToBlob" in canvas ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png"));
      return { bytes: Array.from(new Uint8Array(await output.arrayBuffer())), mimeType: "image/png" };
    } finally { bitmap.close(); }
  } catch {
    warn("Text labels could not be drawn on an image; the original image was imported.");
    return { bytes, mimeType: mime };
  }
}
