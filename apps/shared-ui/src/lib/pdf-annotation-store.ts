import { useCallback, useSyncExternalStore } from "react";
import { createStore } from "@tanstack/react-store";
import * as Y from "yjs";
import { call } from "./backend.ts";
import { createSaveQueue, type SaveQueueStatus } from "./save-queue.ts";
import { assertWritable, registerWriteParticipant } from "./write-lifecycle.ts";
import {
  createPdfAnnotation, readPdfAnnotations, removePdfAnnotation, updatePdfAnnotationComment, updatePdfAnnotationColor,
  type PdfAnnotation, type PdfAnnotationInput, type PdfAnnotationColor,
} from "./pdf-annotations.ts";

type Receipt = { state: number[] | null; revision: number; generation: string };
type Update = { bytes: number[]; generation: string };
type Snapshot = { annotations: PdfAnnotation[]; ready: boolean; saving: boolean; error: string | null };
type Session = {
  id: string; doc: Y.Doc | null; generation: string | null; revision: number;
  snapshot: Snapshot; listeners: Set<() => void>; loading: Promise<void> | null;
  epoch: number; retired: boolean;
};
const sessions = new Map<string, Session>();
const LOCAL = Symbol("local PDF annotation edit");
const CANONICAL = Symbol("persisted PDF annotations");
export const pdfAnnotationSaveStatusStore = createStore<SaveQueueStatus>({ pending: 0, failing: false, lastError: null });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function publish(session: Session, patch: Partial<Snapshot> = {}) {
  session.snapshot = { ...session.snapshot, ...patch };
  session.listeners.forEach(listener => listener());
}
function collect(session: Session) {
  if (session.listeners.size || session.loading || !queue.isIdle(session.id)) return;
  if (sessions.get(session.id) !== session) return;
  sessions.delete(session.id);
  session.epoch++;
  session.doc?.destroy();
}
function documentFor(session: Session) {
  if (session.doc) return session.doc;
  const doc = new Y.Doc();
  session.doc = doc;
  doc.on("update", (bytes: Uint8Array, origin: unknown) => {
    if (origin === LOCAL && session.generation !== null) {
      queue.enqueue(session.id, { bytes: Array.from(bytes), generation: session.generation });
    }
    publish(session, { annotations: readPdfAnnotations(doc) });
  });
  return doc;
}
function merge(session: Session, receipt: Receipt) {
  if (receipt.state) Y.applyUpdate(documentFor(session), new Uint8Array(receipt.state), CANONICAL);
  session.revision = Math.max(session.revision, receipt.revision);
}
function retire(session: Session, error: string) {
  session.retired = true;
  session.epoch++;
  queue.drop(session.id);
  publish(session, { ready: false, saving: false, error });
}
async function load(session: Session) {
  if (session.loading) return session.loading;
  const epoch = session.epoch;
  session.loading = (async () => {
    try {
      const receipt = await call<Receipt>("load_annotations", { documentId: session.id });
      if (session.epoch !== epoch) return;
      if (session.generation !== null && session.generation !== receipt.generation) {
        retire(session, "The database changed. Reopen or retry to load current PDF annotations; older pending edits cannot be replayed.");
        return;
      }
      session.generation = receipt.generation;
      merge(session, receipt);
      publish(session, { ready: true, error: queue.isIdle(session.id) ? null : session.snapshot.error });
    } catch (error) {
      if (session.epoch !== epoch) return;
      if (/document.*(not found|does not exist|deleted)|PDF.*(not found|does not exist|deleted)/i.test(message(error))) retire(session, message(error));
      else publish(session, { error: message(error) });
    }
  })().finally(() => { session.loading = null;
    if (session.epoch !== epoch && !session.retired && session.listeners.size) void load(session);
    collect(session); });
  return session.loading;
}

const queue = createSaveQueue<Update, Receipt>({
  persist: (documentId, update) => persistAdmitted(() => call<Receipt>("save_annotation_update", { documentId, ...update })),
  onSaved: (id, receipt) => {
    const session = sessions.get(id);
    if (!session || session.retired) return;
    if (receipt.generation !== session.generation) {
      retire(session, "The database changed. Retry to load current PDF annotations.");
      return;
    }
    merge(session, receipt);
    publish(session, { error: null });
  },
  onError: (id, error) => {
    const session = sessions.get(id);
    if (!session) return;
    publish(session, { error: message(error) });
    // Verify the generation before any retry. Never attach old bytes to a new token.
    void load(session);
  },
  onStatus: status => {
    pdfAnnotationSaveStatusStore.setState(() => status);
    for (const session of sessions.values()) {
      publish(session, { saving: !queue.isIdle(session.id) });
      collect(session);
    }
  },
});
const persistAdmitted = registerWriteParticipant({
  flush: () => queue.flush(),
  suspend: () => queue.suspend(),
  resume() {
    queue.resume();
    for (const session of sessions.values()) if (!session.retired && !session.snapshot.ready) void load(session);
  },
  discard: resetPdfAnnotationSessions,
});

// DB replacement/deletion retires the previous documents, including late reads.
export function resetPdfAnnotationSessions() {
  queue.clear();
  for (const session of sessions.values()) {
    session.epoch++;
    session.doc?.destroy();
    session.doc = null;
    session.generation = null;
    session.revision = 0;
    session.retired = false;
    publish(session, { annotations: [], ready: false, saving: false, error: null });
    collect(session);
  }
}
export function refreshPdfAnnotations(documentIds: readonly string[]) {
  for (const id of new Set(documentIds)) {
    const session = sessions.get(id);
    if (session && !session.retired) {
      if (session.loading) void session.loading.then(() => load(session));
      else void load(session);
    }
  }
}
export function retryPdfAnnotationSaves() { queue.retryNow(); }

// The reader owns a subscription, while the module owns pending saves.
export function openPdfAnnotations(documentId: string) {
  let session = sessions.get(documentId);
  if (!session) {
    session = {
      id: documentId, doc: null, generation: null, revision: 0,
      snapshot: { annotations: [], ready: false, saving: false, error: null },
      listeners: new Set(), loading: null, epoch: 0, retired: false,
    };
    sessions.set(documentId, session);
  }
  const current = session;
  const writableDoc = () => {
    assertWritable();
    if (!current.snapshot.ready || current.retired) throw new Error("PDF annotations are not ready. Retry loading first.");
    return documentFor(current);
  };
  return {
    getSnapshot: () => current.snapshot,
    subscribe(listener: () => void) {
      current.listeners.add(listener);
      void load(current);
      return () => { current.listeners.delete(listener); collect(current); };
    },
    create(input: PdfAnnotationInput): string {
      const doc = writableDoc();
      let id = "";
      doc.transact(() => { id = createPdfAnnotation(doc, input); }, LOCAL);
      return id;
    },
    updateComment(input: { id: string; body: string }): boolean {
      const doc = writableDoc();
      let updated = false;
      doc.transact(() => { updated = updatePdfAnnotationComment(doc, input); }, LOCAL);
      return updated;
    },
    updateColor(input: { id: string; color: PdfAnnotationColor }): boolean {
      const doc = writableDoc();
      let updated = false;
      doc.transact(() => { updated = updatePdfAnnotationColor(doc, input); }, LOCAL);
      return updated;
    },
    remove(id: string): void {
      const doc = writableDoc();
      doc.transact(() => removePdfAnnotation(doc, id), LOCAL);
    },
    retry(): void {
      assertWritable();
      if (current.retired) {
        current.doc?.destroy(); current.doc = null; current.generation = null;
        current.revision = 0; current.retired = false;
        publish(current, { annotations: [], ready: false, error: null });
      }
      queue.retryNow();
      void load(current);
    },
  };
}
export function usePdfAnnotations(documentId: string) {
  // No I/O during render. subscribe starts the SELECT, including Strict Mode remounts.
  const owner = useCallback(() => openPdfAnnotations(documentId), [documentId]);
  const subscribe = useCallback((listener: () => void) => owner().subscribe(listener), [owner]);
  const getSnapshot = useCallback(() => owner().getSnapshot(), [owner]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, create: (input: PdfAnnotationInput) => owner().create(input),
    updateComment: (input: { id: string; body: string }) => owner().updateComment(input),
    updateColor: (input: { id: string; color: PdfAnnotationColor }) => owner().updateColor(input),
    remove: (id: string) => owner().remove(id), retry: () => owner().retry() };
}
