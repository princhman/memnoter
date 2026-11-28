import type { JSONContent } from "@tiptap/core";
import { Schema, type MarkSpec, type NodeSpec } from "@tiptap/pm/model";
import { cardSnapshot } from "./cards";

export type CardScanRequest = {
  id: number;
  document: JSONContent;
  schema: { topNode: string; nodes: Record<string, NodeSpec>; marks: Record<string, MarkSpec> };
};

export type CardScanReply = { id: number } & ({ cards: ReturnType<typeof cardSnapshot> } | { error: string });

self.onmessage = ({ data }: MessageEvent<CardScanRequest>) => {
  try {
    const document = new Schema(data.schema).nodeFromJSON(data.document);
    self.postMessage({ id: data.id, cards: cardSnapshot(document) } satisfies CardScanReply);
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) } satisfies CardScanReply);
  }
};
