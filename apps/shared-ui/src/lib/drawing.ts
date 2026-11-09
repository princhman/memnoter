// One attribute holds the source/preview pair so concurrent Yjs updates cannot
// assemble a source from one revision and a preview from another.
export type DrawingReference = { version: 1; sourceId: string | null; previewId: string | null };

export function drawingReference(value: unknown): DrawingReference | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  const id = (value: unknown) => value === null || (typeof value === "string" && value.length > 0);
  if (ref.version !== 1 || !id(ref.sourceId) || !id(ref.previewId) || (ref.sourceId === null) !== (ref.previewId === null)) return null;
  return { version: 1, sourceId: ref.sourceId as string | null, previewId: ref.previewId as string | null };
}
