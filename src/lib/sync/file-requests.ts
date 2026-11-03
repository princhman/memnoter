// Lets image views ask for a synced image that has not been downloaded yet,
// and hear when one arrives. Kept apart from the sync manager so editor
// code does not import it (the manager imports the editor's extensions).

import { createStore } from "@tanstack/react-store";

// Bumped whenever a synced image was downloaded.
export const syncedFilesStore = createStore({ version: 0 });

let handler: ((fileId: string) => void) | null = null;

export function setSyncedFileHandler(next: ((fileId: string) => void) | null) {
  handler = next;
}

export function requestSyncedFile(fileId: string) {
  handler?.(fileId);
}

export function syncedFileArrived() {
  syncedFilesStore.setState((state) => ({ version: state.version + 1 }));
}
