import * as Y from "yjs";
import type { PdfRegion } from "./pdf-quote";

export type PdfAnnotationAnchor = { page: number; regions: readonly PdfRegion[] };
export const PDF_ANNOTATION_COLORS = ["primary", "yellow", "green", "blue", "pink"] as const;
export type PdfAnnotationColor = typeof PDF_ANNOTATION_COLORS[number];
export function parsePdfAnnotationColor(value: unknown): PdfAnnotationColor | null {
  return PDF_ANNOTATION_COLORS.find(color => color === value) ?? null;
}
type Selection = { color?: PdfAnnotationColor; anchors: readonly PdfAnnotationAnchor[]; excerpt?: string };
export type PdfAnnotationInput = Selection & (
  | { kind: "highlight"; body?: string }
  | { kind: "comment"; body: string }
);
export type PdfAnnotation = PdfAnnotationInput & { id: string; color: PdfAnnotationColor };

// One caller-owned document per PDF. These roots are not note content.
const annotationsKey = "pdfAnnotations";
const deletionsKey = "pdfAnnotationDeletions";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// These strings are text, never HTML. Allow ordinary line breaks and tabs.
function isPlainText(value: unknown): value is string {
  return typeof value === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

function parseAnchors(value: unknown): PdfAnnotationAnchor[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const anchors: PdfAnnotationAnchor[] = [];
  let previousPage = 0;
  for (const anchor of value) {
    if (!isRecord(anchor) || typeof anchor.page !== "number" || !Number.isSafeInteger(anchor.page) ||
      anchor.page <= previousPage || !Array.isArray(anchor.regions) || anchor.regions.length === 0) return null;
    const regions: PdfRegion[] = [];
    for (const region of anchor.regions) {
      if (!isRecord(region)) return null;
      const { x, y, width, height } = region;
      if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
        ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x + width > 1 || y + height > 1) return null;
      regions.push({ x, y, width, height });
    }
    anchors.push({ page: anchor.page, regions });
    previousPage = anchor.page;
  }
  return anchors;
}

function parseInput(value: unknown, requireCommentBody = true): PdfAnnotationInput | null {
  if (!isRecord(value)) return null;
  const anchors = parseAnchors(value.anchors);
  if (value.color !== undefined && !parsePdfAnnotationColor(value.color)) return null;
  if (!anchors || (value.excerpt !== undefined && !isPlainText(value.excerpt))) return null;
  const selection: Selection = { anchors, ...(value.excerpt === undefined ? {} : { excerpt: value.excerpt }), ...(value.color === undefined ? {} : { color: parsePdfAnnotationColor(value.color) ?? "primary" }) };
  if (value.kind === "comment" && isPlainText(value.body) && (!requireCommentBody || value.body.trim())) {
    return { ...selection, kind: "comment", body: value.body };
  }
  if (value.kind === "highlight" && (value.body === undefined || isPlainText(value.body))) {
    return value.body === undefined ? { ...selection, kind: "highlight" } : { ...selection, kind: "highlight", body: value.body };
  }
  return null;
}

// getMap upgrades a decoded root's type without emitting an update. Do not even
// register a root on an empty doc during a read or a missing-item edit.
function existingMap(doc: Y.Doc, key: string): Y.Map<unknown> | undefined {
  if (!doc.share.has(key)) return undefined;
  try { return doc.getMap<unknown>(key); } catch { return undefined; }
}

function readEntry(id: string, value: unknown): PdfAnnotation | null {
  if (!uuid.test(id) || !(value instanceof Y.Map)) return null;
  const body = value.get("body");
  if (!(body instanceof Y.Text) || body.toDelta().some((part: unknown) => !isRecord(part) || typeof part.insert !== "string")) return null;
  const input = parseInput({ kind: value.get("kind"), anchors: value.get("anchors"), excerpt: value.get("excerpt"), body: body.toString() }, false);
  return input ? { ...input, id, color: parsePdfAnnotationColor(value.get("color")) ?? "primary" } : null;
}

/** Pure snapshot, ordered by stable ID. Malformed remote entries are omitted.
 * Pages are one-based and strictly increasing; region bounds are in [0, 1].
 * No roots or Yjs updates are created by reading an empty document.
 */
export function readPdfAnnotations(doc: Y.Doc): PdfAnnotation[] {
  const annotations = existingMap(doc, annotationsKey);
  const deletions = existingMap(doc, deletionsKey);
  const result: PdfAnnotation[] = [];
  annotations?.forEach((value, id) => {
    if (deletions?.has(id)) return;
    const annotation = readEntry(id, value);
    if (annotation) result.push(annotation);
  });
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** First mutation may register roots. Caller owns persistence and encoding via
 * Y.encodeStateAsUpdate / Y.applyUpdate; this module performs no I/O.
 * Anchors and kind are immutable. Creates always allocate a fresh UUID.
 */
export function createPdfAnnotation(doc: Y.Doc, input: PdfAnnotationInput): string {
  const parsed = parseInput(input);
  if (!parsed) throw new TypeError("Invalid PDF annotation selection or text");
  const id = crypto.randomUUID();
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    entry.set("kind", parsed.kind);
    entry.set("color", parsed.color ?? "primary");
    entry.set("anchors", parsed.anchors);
    if (parsed.excerpt !== undefined) entry.set("excerpt", parsed.excerpt);
    const body = new Y.Text();
    if (parsed.body) body.insert(0, parsed.body);
    entry.set("body", body);
    doc.getMap<unknown>(annotationsKey).set(id, entry);
  });
  return id;
}

function validateId(id: string) {
  if (typeof id !== "string" || !uuid.test(id)) throw new TypeError("Invalid PDF annotation UUID");
}

/** Replace the locally observed body with a minimal text splice. Disjoint
 * concurrent edits merge; overlapping edits follow Y.Text ordering and may
 * combine text. This is not a last-writer-wins whole-comment replacement.
 * Concurrent deletions may leave an empty comment; reads keep it visible and
 * editable even though local comment actions always require nonempty text.
 * Empty text clears a highlight's optional comment; comments require a body.
 * Returns false for missing, deleted, or malformed entries.
 */
export function updatePdfAnnotationComment(doc: Y.Doc, input: { id: string; body: string }): boolean {
  validateId(input.id);
  if (!isPlainText(input.body)) throw new TypeError("Invalid PDF annotation text");
  if (existingMap(doc, deletionsKey)?.has(input.id)) return false;
  const entry = existingMap(doc, annotationsKey)?.get(input.id);
  const annotation = readEntry(input.id, entry);
  if (!annotation || !(entry instanceof Y.Map)) return false;
  if (annotation.kind === "comment" && !input.body.trim()) throw new TypeError("A PDF comment requires nonempty text");
  const body = entry.get("body");
  if (!(body instanceof Y.Text)) return false;
  // Compare code points so Y.Text never splits an emoji's surrogate pair.
  // Convert back to UTF-16 offsets, which is what Y.Text indexes use.
  const before = Array.from(body.toString());
  const after = Array.from(input.body);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const offset = before.slice(0, start).join("").length;
  const removedLength = before.slice(start, end).join("").length;
  const inserted = after.slice(start, nextEnd).join("");
  doc.transact(() => {
    if (removedLength) body.delete(offset, removedLength);
    if (inserted) body.insert(offset, inserted);
  });
  return true;
}

/** Colour is an independent Y.Map field so recolouring merges with comment edits. */
export function updatePdfAnnotationColor(doc: Y.Doc, input: { id: string; color: PdfAnnotationColor }): boolean {
  validateId(input.id);
  if (!parsePdfAnnotationColor(input.color)) throw new TypeError("Invalid PDF annotation colour");
  if (existingMap(doc, deletionsKey)?.has(input.id)) return false;
  const entry = existingMap(doc, annotationsKey)?.get(input.id);
  if (!(entry instanceof Y.Map) || !readEntry(input.id, entry)) return false;
  if (entry.get("color") !== input.color) entry.set("color", input.color);
  return true;
}

/** Permanent remove-wins tombstone, including for not-yet-received IDs.
 * Never clear tombstones or reuse IDs: delayed creates/edits must stay hidden.
 * Retain them when encoding/compacting this document. PDF deletion and any
 * future tombstone garbage collection belong to the storage lifecycle.
 */
export function removePdfAnnotation(doc: Y.Doc, id: string): void {
  validateId(id);
  const deletions = existingMap(doc, deletionsKey);
  if (deletions?.has(id)) return;
  doc.getMap<unknown>(deletionsKey).set(id, true);
}
