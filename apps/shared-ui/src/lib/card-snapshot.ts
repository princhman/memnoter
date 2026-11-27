import type { MarkSpec, Node, NodeSpec, Schema } from "@tiptap/pm/model";
import { cardSnapshot } from "./cards";
import type { CardScanRequest, CardScanReply } from "./card-snapshot.worker";

type Cards = ReturnType<typeof cardSnapshot>;

let worker: Worker | undefined;
let workerUnavailable = false;
let sequence = 0;
const pending = new Map<number, { resolve: (cards: Cards) => void; reject: (error: unknown) => void }>();

// Extraction needs the persisted tree and mark names, without DOM rendering
// or editor plugins. Keep the schema's defaults and content expressions.
function schemaData(schema: Schema): CardScanRequest["schema"] {
  const attrs = (spec: NodeSpec | MarkSpec) => Object.fromEntries(
    Object.entries(spec.attrs ?? {}).map(([name, attr]) => [name, "default" in attr ? { default: attr.default } : {}]),
  );
  const nodes = Object.fromEntries(Object.entries(schema.nodes).map(([name, { spec }]) => [
    name, { group: spec.group, inline: spec.inline, content: spec.content, code: spec.code, attrs: attrs(spec) },
  ]));
  const marks = Object.fromEntries(Object.entries(schema.marks).map(([name, { spec }]) => [
    name, { code: spec.code, attrs: attrs(spec) },
  ]));
  return { topNode: schema.topNodeType.name, nodes, marks };
}

function scanner() {
  if (worker) return worker;
  const next = new Worker(new URL("./card-snapshot.worker.ts", import.meta.url), { type: "module" });
  const stop = (error: unknown) => {
    next.terminate();
    worker = undefined;
    workerUnavailable = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  next.onerror = stop;
  next.onmessageerror = stop;
  next.onmessage = ({ data }: MessageEvent<CardScanReply>) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if ("cards" in data) request?.resolve(data.cards);
    else request?.reject(new Error(data.error));
  };
  worker = next;
  return next;
}

export async function readCardSnapshot(document: Node): Promise<Cards> {
  if (!workerUnavailable && document.content.size > 30_000 && typeof Worker !== "undefined") {
    const id = ++sequence;
    try {
      const next = scanner();
      return await new Promise<Cards>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        next.postMessage({ id, document: document.toJSON(), schema: schemaData(document.type.schema) } satisfies CardScanRequest);
      });
    } catch (error) {
      pending.delete(id);
      if (!worker) workerUnavailable = true;
      console.warn("Could not extract cards in the background:", error);
    }
  }
  return cardSnapshot(document);
}
