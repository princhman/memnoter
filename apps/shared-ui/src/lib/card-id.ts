// Persisted grammar: block IDs are opaque UUIDs without colons. Cloze and
// mask IDs are opaque suffixes (including legacy IDs); never rewrite them.
export function basicCardId(blockId: string, reverse = false): string {
  return reverse ? `${blockId}:reverse` : blockId;
}
export function clozeCardId(blockId: string, clozeId: string): string {
  return `${blockId}:${clozeId}`;
}
export function occlusionCardId(imageId: string, maskId: string): string {
  return `${imageId}:o:${maskId}`;
}

export type ParsedCardId =
  | { kind: "basic"; blockId: string; reverse: boolean }
  | { kind: "cloze"; blockId: string; clozeId: string }
  | { kind: "occlusion"; blockId: string; maskId: string };

export function parseCardId(id: string): ParsedCardId {
  const colon = id.indexOf(":");
  if (colon < 0) return { kind: "basic", blockId: id, reverse: false };
  const blockId = id.slice(0, colon);
  const suffix = id.slice(colon + 1);
  if (suffix === "reverse") return { kind: "basic", blockId, reverse: true };
  if (suffix.startsWith("o:")) return { kind: "occlusion", blockId, maskId: suffix.slice(2) };
  return { kind: "cloze", blockId, clozeId: suffix };
}

export function blockIdOf(id: string): string { return parseCardId(id).blockId; }
export function siblingOf(id: string): string | null {
  const parsed = parseCardId(id);
  return parsed.kind === "basic" ? basicCardId(parsed.blockId, !parsed.reverse) : null;
}
