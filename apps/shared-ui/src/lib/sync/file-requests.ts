// Lightweight download requests and arrival notifications shared by image views
// and the sync manager, without loading the sync engine into each image viewer.

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
