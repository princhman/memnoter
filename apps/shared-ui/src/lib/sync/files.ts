// Moves images between this device and R2, encrypted, outside the log. Images
// never change once saved, so each is uploaded once and downloaded once.
// Uploads come from `sync_file_uploads`; downloads are the images other
// devices announced in the vault that this one lacks. Server deletions wait
// for the core to confirm that their tombstones were acknowledged.

import { call as invoke } from "@/lib/backend";
import type { FileType } from "@/lib/content";
import { deleteObject, getObject, putObject, SyncApiError } from "./account";
import { SYNC_CONTRACT } from "./protocol";
import { decryptBlob, encryptBlob } from "./crypto";

type MissingFile = { fileId: string; moduleId: string; fileType: string };

const RETRY_MS = 30_000;
const KICK_DELAY_MS = 1_000;

// Authenticated data for an image, so a blob cannot pass for another one.
const fileDoc = (fileId: string) => `${SYNC_CONTRACT.fileAadPrefix}${fileId}`;

export type FileSyncOptions = {
  generation: string;
  signal?: AbortSignal;
  server: string;
  token: string;
  key: CryptoKey;
  onStored: (moduleId: string, file: FileType) => void;
  onUnauthorized: () => void;
};

export function createFileSync({ generation, signal, server, token, key, onStored, onUnauthorized }: FileSyncOptions) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let running = true;
  let busy = false;
  let drained: Promise<void> = Promise.resolve();
  let finish: (() => void) | undefined;
  let again = false;
  let kickTimer: number | undefined;
  let retryTimer: number | undefined;
  // Images someone is looking at come first.
  const wanted = new Set<string>();
  // Downloads the server did not have yet; another device is still uploading.
  const notYet = new Set<string>();
  const notYetAttempts = new Map<string, number>();

  async function upload(fileId: string) {
    const contents = await invoke<{ bytes: number[] }>("read_file", { moduleId: "", fileId });
    const blob = await encryptBlob(key, fileDoc(fileId), new Uint8Array(contents.bytes));
    await putObject(server, token, "files", fileId, blob, controller.signal);
    if (!running) return;
    await invoke("sync_upload_done", { fileId, generation });
  }

  async function download(file: MissingFile) {
    const blob = await getObject(server, token, "files", file.fileId, controller.signal);
    if (!running) return;
    if (!blob) {
      notYet.add(file.fileId);
      notYetAttempts.set(file.fileId, Math.min(5, (notYetAttempts.get(file.fileId) ?? 0) + 1));
      return;
    }
    const bytes = await decryptBlob(key, fileDoc(file.fileId), blob);
    if (!running) return;
    const stored = await invoke<FileType>("sync_store_file", {
      generation,
      fileId: file.fileId,
      moduleId: file.moduleId,
      fileType: file.fileType,
      bytes: Array.from(bytes),
    });
    notYetAttempts.delete(file.fileId);
    wanted.delete(file.fileId);
    onStored(file.moduleId, stored);
  }

  async function pass() {
    let failed = false;
    const attempt = async (fileId: string, task: () => Promise<void>) => {
      try {
        await task();
      } catch (error) {
        if (!running || controller.signal.aborted) return;
        if (error instanceof SyncApiError && error.status === 410) {
          await invoke("sync_file_gone", { fileId, generation });
          wanted.delete(fileId);
          notYet.delete(fileId);
          return;
        }
        if (error instanceof SyncApiError && error.status === 401) {
          running = false;
          onUnauthorized();
          return;
        }
        console.error("Image sync failed:", error);
        failed = true;
      }
    };

    for (const fileId of await invoke<string[]>("sync_pending_uploads", { generation })) {
      if (!running) return;
      await attempt(fileId, () => upload(fileId));
    }
    for (const fileId of await invoke<string[]>("sync_pending_deletes", { generation })) {
      if (!running) return;
      await attempt(fileId, async () => {
        await deleteObject(server, token, fileId, controller.signal);
        if (!running) return;
        await invoke("sync_delete_done", { fileId, generation });
      });
    }
    notYet.clear();
    const missing = await invoke<MissingFile[]>("sync_missing_files", { generation });
    const pending = new Set(missing.map(file => file.fileId));
    for (const id of notYetAttempts.keys()) if (!pending.has(id)) notYetAttempts.delete(id);
    missing.sort((a, b) => Number(wanted.has(b.fileId)) - Number(wanted.has(a.fileId)));
    for (const file of missing) {
      if (!running) return;
      await attempt(file.fileId, () => download(file));
    }
    if (running && (failed || notYet.size > 0)) {
      window.clearTimeout(retryTimer);
      const delay = notYet.size > 0
        ? Math.min(...[...notYet].map(id => Math.min(RETRY_MS, 2_000 * 2 ** ((notYetAttempts.get(id) ?? 1) - 1))))
        : RETRY_MS;
      retryTimer = window.setTimeout(() => void run(), delay);
    }
  }

  async function run() {
    if (!running) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    drained = new Promise<void>((resolve) => { finish = resolve; });
    try {
      do {
        again = false;
        await pass();
      } while (again && running);
    } catch (error) {
      console.error("Image sync failed:", error);
    } finally {
      busy = false;
      finish?.();
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
      controller.abort();
      signal?.removeEventListener("abort", abort);
      window.clearTimeout(kickTimer);
      window.clearTimeout(retryTimer);
      return drained;
    },
  };
}

export type FileSync = ReturnType<typeof createFileSync>;
