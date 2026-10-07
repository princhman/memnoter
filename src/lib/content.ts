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

export async function loadContent(moduleId: string): Promise<GetContentResponse> {
  const canCleanUp = !loadedModules.has(moduleId);
  loadedModules.add(moduleId);
  const content = await invoke<GetContentResponse>("get_content", { moduleId });
  if (!canCleanUp || content.files.length === 0) return content;

  const doc = new Y.Doc();
  try {
    if (content.state.length > 0) {
      Y.applyUpdate(doc, new Uint8Array(content.state));
    }
    for (const update of content.updates) {
      Y.applyUpdate(doc, new Uint8Array(update.bytes));
    }

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
    doc.destroy();
  }
}
