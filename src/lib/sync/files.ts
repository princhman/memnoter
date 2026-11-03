// Moves images between this device and R2, encrypted, outside the log. Images
// never change once saved, so each is uploaded once and downloaded once.
// Uploads come from `sync_file_uploads`; downloads are the images other
// devices announced in the vault that this one lacks.

import { invoke } from "@tauri-apps/api/core";
import type { FileType } from "@/lib/content";
import { getObject, putObject, SyncApiError } from "./account";
import { decryptBlob, encryptBlob } from "./crypto";

type MissingFile = { fileId: string; moduleId: string; fileType: string };

const RETRY_MS = 30_000;
const KICK_DELAY_MS = 1_000;

// Authenticated data for an image, so a blob cannot pass for another one.
const fileDoc = (fileId: string) => `file:${fileId}`;

export type FileSyncOptions = {
  server: string;
  token: string;
  key: CryptoKey;
  onStored: (moduleId: string, file: FileType) => void;
  onUnauthorized: () => void;
};

export function createFileSync({ server, token, key, onStored, onUnauthorized }: FileSyncOptions) {
  let running = true;
  let busy = false;
  let again = false;
  let kickTimer: number | undefined;
  let retryTimer: number | undefined;
  // Images someone is looking at come first.
  const wanted = new Set<string>();
  // Downloads the server did not have yet; another device is still uploading.
  const notYet = new Set<string>();

  async function upload(fileId: string) {
    const contents = await invoke<{ bytes: number[] }>("read_file", { moduleId: "", fileId });
    const blob = await encryptBlob(key, fileDoc(fileId), new Uint8Array(contents.bytes));
    await putObject(server, token, "files", fileId, blob);
    await invoke("sync_upload_done", { fileId });
  }

  async function download(file: MissingFile) {
    const blob = await getObject(server, token, "files", file.fileId);
    if (!blob) {
      notYet.add(file.fileId);
      return;
    }
    const bytes = await decryptBlob(key, fileDoc(file.fileId), blob);
    const stored = await invoke<FileType>("sync_store_file", {
      fileId: file.fileId,
      moduleId: file.moduleId,
      fileType: file.fileType,
      bytes: Array.from(bytes),
    });
    wanted.delete(file.fileId);
    onStored(file.moduleId, stored);
  }

  async function pass() {
    let failed = false;
    const attempt = async (task: () => Promise<void>) => {
      try {
        await task();
      } catch (error) {
        if (error instanceof SyncApiError && error.status === 401) {
          running = false;
          onUnauthorized();
          return;
        }
        console.error("Image sync failed:", error);
        failed = true;
      }
    };

    for (const fileId of await invoke<string[]>("sync_pending_uploads")) {
      if (!running) return;
      await attempt(() => upload(fileId));
    }
    notYet.clear();
    const missing = await invoke<MissingFile[]>("sync_missing_files");
    missing.sort((a, b) => Number(wanted.has(b.fileId)) - Number(wanted.has(a.fileId)));
    for (const file of missing) {
      if (!running) return;
      await attempt(() => download(file));
    }
    if (failed || notYet.size > 0) {
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void run(), RETRY_MS);
    }
  }

  async function run() {
    if (!running) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await pass();
      } while (again && running);
    } catch (error) {
      console.error("Image sync failed:", error);
    } finally {
      busy = false;
    }
  }

  return {
    // Something may need uploading or downloading.
    kick() {
      window.clearTimeout(kickTimer);
      kickTimer = window.setTimeout(() => void run(), KICK_DELAY_MS);
    },
    // An image on screen is missing: fetch it before the others.
    request(fileId: string) {
      if (wanted.has(fileId)) return;
      wanted.add(fileId);
      void run();
    },
    stop() {
      running = false;
      window.clearTimeout(kickTimer);
      window.clearTimeout(retryTimer);
    },
  };
}

export type FileSync = ReturnType<typeof createFileSync>;
