import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ProsemirrorBinding, ySyncPluginKey } from "@tiptap/y-tiptap";
import { outline } from "./outline";

export type PdfRegion = { x: number; y: number; width: number; height: number };
export type PdfSource = { documentId: string; page: number; name: string; region: PdfRegion };
function parsePdfRegion(value: unknown): PdfRegion | null {
  if (!value || typeof value !== "object" || !("x" in value) || !("y" in value) || !("width" in value) || !("height" in value)) return null;
  const { x, y, width, height } = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  return { x, y, width, height };
}
export function parsePdfSource(value: unknown): PdfSource | null {
  if (!value || typeof value !== "object" || !("documentId" in value) || typeof value.documentId !== "string" || !value.documentId.trim() || /[\u0000-\u001f\u007f]/.test(value.documentId) ||
    !("page" in value) || typeof value.page !== "number" || !Number.isSafeInteger(value.page) || value.page < 1 ||
    !("name" in value) || typeof value.name !== "string" || !("region" in value)) return null;
  const region = parsePdfRegion(value.region);
  return region ? { documentId: value.documentId, page: value.page, name: value.name, region } : null;
}
// Coordinates are relative to the page's current CSS rectangle, independent of scrolling and zoom.
export function normalizePdfRegion(start: { x: number; y: number }, end: { x: number; y: number }, size: { width: number; height: number }): PdfRegion | null {
  if (![start.x, start.y, end.x, end.y, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0) return null;
  const x1 = Math.max(0, Math.min(size.width, start.x)); const x2 = Math.max(0, Math.min(size.width, end.x));
  const y1 = Math.max(0, Math.min(size.height, start.y)); const y2 = Math.max(0, Math.min(size.height, end.y));
  if (Math.abs(x2 - x1) < 4 || Math.abs(y2 - y1) < 4) return null;
  const x = Math.min(x1, x2) / size.width, y = Math.min(y1, y2) / size.height;
  return { x, y, width: Math.min(1 - x, Math.abs(x2 - x1) / size.width), height: Math.min(1 - y, Math.abs(y2 - y1) / size.height) };
}
export async function cropPdfCanvas(canvas: HTMLCanvasElement, region: PdfRegion) {
  if (!canvas.width || !canvas.height || !parsePdfRegion(region)) {
    throw new Error("PDF page or region is not ready. Select the region again.");
  }
  const crop = document.createElement("canvas");
  const x = Math.min(canvas.width - 1, Math.round(region.x * canvas.width)), y = Math.min(canvas.height - 1, Math.round(region.y * canvas.height));
  crop.width = Math.min(canvas.width - x, Math.max(1, Math.round((region.x + region.width) * canvas.width) - x));
  crop.height = Math.min(canvas.height - y, Math.max(1, Math.round((region.y + region.height) * canvas.height) - y));
  const context = crop.getContext("2d");
  if (!context || !canvas.width || !canvas.height) throw new Error("PDF page is not ready. Select the region again.");
  context.drawImage(canvas, x, y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return new Promise<Blob>((resolve, reject) => crop.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not create quote PNG")), "image/png"));
}
// A cursor maps through edits while saving; a section resolves by identity after saving.
export function quoteTarget(editor: Editor, target: { position: number } | { headingId: string | null }) {
  let position = "position" in target ? target.position : 0;
  const candidate: unknown = ySyncPluginKey.getState(editor.state)?.binding;
  const binding = candidate instanceof ProsemirrorBinding ? candidate : null;
  const relative = binding && "position" in target ? absolutePositionToRelativePosition(position, binding.type, binding.mapping) : null;
  const map = ({ transaction }: { transaction: Transaction }) => { position = transaction.mapping.map(position); };
  editor.on("transaction", map);
  return {
    resolve() {
      if ("position" in target) {
        if (binding && relative) {
          const resolved = relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
          if (resolved === null) throw new Error("The quote insertion point was removed. Discard this operation and choose another position.");
          return resolved;
        }
        return position;
      }
      if (target.headingId === null) return editor.state.doc.content.size;
      const section = outline(editor.state.doc).find(h => h.id === target.headingId);
      if (!section) throw new Error("The destination section was removed. Discard this operation and choose another section.");
      return section.end;
    },
    dispose: () => { editor.off("transaction", map); },
  };
}
