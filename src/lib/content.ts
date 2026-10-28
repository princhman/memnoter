import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";

export type ContentUpdate = {
  id: number;
  bytes: number[];
};

export type FileType = {
  id: string;
  path: string;
  file_type: string;
};

export type GetContentResponse = {
  state: number[];
  updates: ContentUpdate[];
  files: FileType[];
};

// Only collect on the first load of a note in this app session. Later loads
// may overlap pending pastes/saves or an editor with live undo/redo history.
const loadedModules = new Set<string>();

export function applySavedContent(doc: Y.Doc, content: GetContentResponse) {
  // Notify the editor once with the finished document, not after every edit
  // in the persisted history. Loading must not enter autosave or undo history.
  doc.transact(() => {
    if (content.state.length > 0) {
      Y.applyUpdate(doc, new Uint8Array(content.state));
    }
    for (const update of content.updates) {
      Y.applyUpdate(doc, new Uint8Array(update.bytes));
    }
  }, "tauri-load");
}

export async function loadContent(
  moduleId: string,
  document?: Y.Doc,
): Promise<GetContentResponse> {
  const canCleanUp = !loadedModules.has(moduleId);
  loadedModules.add(moduleId);
  const content = await invoke<GetContentResponse>("get_content", { moduleId });
  // Reuse the live document for cleanup instead of decoding its history twice.
  // A restore failure must reject loading, rather than expose an empty editor.
  if (document) applySavedContent(document, content);
  if (!canCleanUp || content.files.length === 0) return content;

  const doc = document ?? new Y.Doc();
  try {
    if (!document) applySavedContent(doc, content);

    // Incomplete update chains cannot prove that a file is unused.
    if (doc.store.pendingStructs || doc.store.pendingDs) return content;

    const referenced = new Set<string>();
    for (const node of doc.getXmlFragment("default").createTreeWalker(() => true)) {
      if (node instanceof Y.XmlElement) {
        const fileId = node.getAttribute("fileId");
        if (typeof fileId === "string") referenced.add(fileId);
      }
    }
    const fileIds = content.files
      .filter((file) => !referenced.has(file.id))
      .map((file) => file.id);
    if (fileIds.length === 0) return content;

    const deletedIds = new Set(
      await invoke<string[]>("cleanup_files", {
        moduleId,
        fileIds,
        expectedState: content.state,
        expectedUpdateId: content.updates.reduce(
          (latest, update) => Math.max(latest, update.id),
          0,
        ),
      }),
    );
    return {
      ...content,
      files: content.files.filter((file) => !deletedIds.has(file.id)),
    };
  } catch (error) {
    // Cleanup must never prevent opening a note. Retained rows allow retrying
    // failed disk removals on the next app launch.
    console.error("Failed to clean up unused images:", error);
    return content;
  } finally {
    if (!document) doc.destroy();
  }
}

// Receipts outlive reads and cache eviction. A query may publish a disk snapshot
// taken before add_update completed, even after onSaved patched the cache.
const checkpoints = new Map<string, number[]>();
const acknowledgements = new Map<string, Map<number, ContentUpdate>>();
export function acknowledgeContent(moduleId: string, update: ContentUpdate) {
  let receipts = acknowledgements.get(moduleId);
  if (!receipts) acknowledgements.set(moduleId, receipts = new Map());
  receipts.set(update.id, update);
}
export function acknowledgeCompaction(moduleId: string, state: number[], represented: ContentUpdate[]) {
  checkpoints.set(moduleId, state);
  const receipts = acknowledgements.get(moduleId);
  for (const update of represented) {
    if (receipts?.get(update.id) === update) receipts.delete(update.id);
  }
}
export function reconcileContent(moduleId: string, content: GetContentResponse): GetContentResponse {
  const updates = new Map(content.updates.map(update => [update.id, update]));
  for (const update of acknowledgements.get(moduleId)?.values() ?? []) updates.set(update.id, update);
  const checkpoint = checkpoints.get(moduleId);
  const state = checkpoint ? Array.from(Y.mergeUpdates([new Uint8Array(content.state.length ? content.state : [0, 0]), new Uint8Array(checkpoint)])) : content.state;
  return { ...content, state, updates: [...updates.values()].sort((a, b) => a.id - b.id) };
}
export function contentQueryOptions(moduleId: string) {
  return {
    queryKey: ["content", moduleId],
    // Runs at QueryClient publication, including after an outstanding read.
    structuralSharing: (_old: unknown, incoming: unknown) => reconcileContent(moduleId, incoming as GetContentResponse),
  };
}
