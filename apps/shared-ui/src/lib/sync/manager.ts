// Runs cloud sync for the app: owns the engine, adapts it to the Tauri
// commands in apps/desktop/src/sync.rs and folds remote changes into the caches
// the editor reads, exactly like a local save would.

import { call as invoke } from "@/lib/backend";
import { listen } from "@/lib/backend";
import { createStore } from "@tanstack/react-store";
import * as Y from "yjs";
import { acknowledgeContent, type ContentUpdate, type FileType, type GetContentResponse } from "@/lib/content";
import { dueCountsKey, isModuleOpen } from "@/lib/card-sync";
import { reindexStoredCards } from "@/lib/card-backfill";
import { queryClient } from "@/lib/query-client";
import { exclusiveWrite } from "@/lib/write-lifecycle";
import { saveQueue } from "@/lib/saves";
import { indexStoredNote } from "@/lib/search-index";
import { forgetModule } from "@/lib/store";
import { getObject, isTokenValid, putObject, wipeCloudData, type SyncAccount } from "./account";
import { importKey } from "./crypto";
import { createFileSync, type FileSync } from "./files";
import { setSyncedFileHandler, syncedFileArrived } from "./file-requests";
import { AUTH_PROTOCOL_PREFIX, SYNC_PROTOCOL } from "./protocol";
import {
  createSyncEngine,
  type BlobStore,
  type SyncEngine,
  type SyncSocket,
  type SyncState,
  type SyncStore,
} from "./engine";

// Dispatched on window with the module id when another device deleted it.
export const MODULE_DELETED_REMOTELY_EVENT = "memnoter:module-deleted-remotely";

const REINDEX_DELAY_MS = 2_000;

export type SyncUiStatus = {
  // null until the stored account was read.
  account: Omit<SyncAccount, "key" | "token"> | null;
  loaded: boolean;
  state: SyncState;
  error: string | null;
  lastSyncedAt: number | null;
};

export const syncStatusStore = createStore<SyncUiStatus>({
  account: null,
  loaded: false,
  state: "idle",
  error: null,
  lastSyncedAt: null,
});

type SyncStatusResponse = { generation: string; account: string | null; cursor: number; pending: number };
export type ApplyResult = {
  updates: { moduleId: string; update: ContentUpdate }[];
  modulesChanged: boolean;
  deleted: string[];
  reviewsChanged: boolean;
  filesChanged: boolean;
};

let requestController: AbortController | null = null;
let engine: SyncEngine | null = null;
let fileSync: FileSync | null = null;
let activeAccount: SyncAccount | null = null;
let unlisten: (() => void) | null = null;
// Starting and stopping run one at a time, so two engines never overlap.
let transitions: Promise<unknown> = Promise.resolve();
let started: Promise<void> | null = null;
let draining: Promise<unknown> = Promise.resolve();

function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = transitions.then(task, task);
  transitions = next.catch(() => {});
  return next;
}

function writesAllowed() {
  // A backup restore replaces the database; nothing may write meanwhile.
  if (saveQueue.isSuspended()) throw new Error("Writes are paused");
}

const reindexTimers = new Map<string, number>();
const reindexing = new Set<Promise<void>>();
function scheduleReindex(moduleId: string) {
  window.clearTimeout(reindexTimers.get(moduleId));
  reindexTimers.set(
    moduleId,
    window.setTimeout(() => {
      const task = (async () => {
        reindexTimers.delete(moduleId);
        // An open note indexes itself as the editor shows the change.
        if (isModuleOpen(moduleId)) return;
        try {
          await indexStoredNote(moduleId);
          await reindexStoredCards(moduleId);
          void queryClient.invalidateQueries({ queryKey: dueCountsKey });
        } catch (error) {
          console.error(`Failed to index synced note ${moduleId}:`, error);
        }
      })();
      reindexing.add(task);
      void task.finally(() => reindexing.delete(task));
    }, REINDEX_DELAY_MS),
  );
}

export function onRemote(result: ApplyResult) {
  for (const { moduleId, update } of result.updates) {
    // The same path as a local save: an open editor applies the update from
    // the cache, and compaction then includes it.
    acknowledgeContent(moduleId, update);
    queryClient.setQueryData<GetContentResponse>(
      ["content", moduleId],
      (content) => content && { ...content, updates: [...content.updates, update] },
    );
    scheduleReindex(moduleId);
  }
  for (const moduleId of result.deleted) {
    saveQueue.drop(moduleId);
    forgetModule(moduleId);
    window.dispatchEvent(new CustomEvent(MODULE_DELETED_REMOTELY_EVENT, { detail: moduleId }));
    queryClient.removeQueries({ queryKey: ["content", moduleId] });
  }
  if (result.modulesChanged || result.deleted.length > 0) {
    void queryClient.invalidateQueries({ queryKey: ["modules"] });
  }
  if (result.modulesChanged || result.deleted.length > 0 || result.reviewsChanged) {
    // Card schedules are under the due counts' key too.
    void queryClient.invalidateQueries({ queryKey: dueCountsKey });
  }
  if (result.filesChanged) fileSync?.kick();
}

export function onFileStored(moduleId: string, file: FileType) {
  queryClient.setQueryData<GetContentResponse>(
    ["content", moduleId],
    (content) => content && !content.files.some((known) => known.id === file.id)
      ? { ...content, files: [...content.files, file] }
      : content,
  );
  syncedFileArrived();
  // Image occlusion cards need their image to be indexed.
  scheduleReindex(moduleId);
}



function tauriStore(generation: string): SyncStore {
  return {
    async cursor() {
      return (await invoke<SyncStatusResponse>("sync_status")).cursor;
    },
    async outbox(limitBytes) {
      const entries = await invoke<{ id: number; doc: string; bytes: number[] }[]>("sync_outbox", { limitBytes, generation });
      return entries.map((entry) => ({ ...entry, bytes: new Uint8Array(entry.bytes) }));
    },
    async ackOutbox(maxId) {
      await invoke("sync_ack", { maxId, generation });
    },
    async applyRemote(entries, cursor) {
      writesAllowed();
      const result = await invoke<ApplyResult>("sync_apply", {
        entries: entries.map((entry) => ({ seq: entry.seq, doc: entry.doc, bytes: Array.from(entry.bytes) })),
        cursor, generation,
      });
      onRemote(result);
    },
    async setCursor(cursor) {
      await invoke("sync_set_cursor", { cursor, generation });
    },
    async snapshot(doc) {
      const state = await invoke<number[] | null>("sync_snapshot", { doc, generation });
      return state ? new Uint8Array(state) : null;
    },
  };
}

function blobStore(account: SyncAccount, signal: AbortSignal): BlobStore {
  return {
    put: (id, blob) => putObject(account.server, account.token, "blobs", id, blob, signal),
    async get(id) {
      const blob = await getObject(account.server, account.token, "blobs", id, signal);
      if (!blob) throw new Error("A synced change is missing from the server");
      return blob;
    },
  };
}

function socketUrl(server: string) {
  return `${server.replace(/\/+$/, "").replace(/^http/, "ws")}/v1/sync`;
}

function browserSocket(account: SyncAccount, onUnauthorized: () => void, signal: AbortSignal) {
  return (): SyncSocket => {
    const ws = new WebSocket(socketUrl(account.server), [SYNC_PROTOCOL, `${AUTH_PROTOCOL_PREFIX}${account.token}`]);
    let opened = false;
    const socket: SyncSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (data) => ws.send(data),
      close: (code, reason) => {
        try {
          ws.close(code === undefined || code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
        } catch {
          ws.close();
        }
      },
    };
    ws.onopen = () => {
      opened = true;
      socket.onopen?.();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") socket.onmessage?.(event.data);
    };
    ws.onclose = (event) => {
      socket.onclose?.(event.code, event.reason);
      // A refused handshake looks like any network failure; ask the server.
      if (!opened && !signal.aborted) {
        void isTokenValid(account.server, account.token, signal).then((valid) => {
          if (!valid) onUnauthorized();
        });
      }
    };
    return socket;
  };
}

function publicAccount(account: SyncAccount): SyncUiStatus["account"] {
  return { server: account.server, email: account.email, userId: account.userId };
}

async function readAccount(): Promise<SyncAccount | null> {
  const { account } = await invoke<SyncStatusResponse>("sync_status");
  if (!account) return null;
  try {
    return JSON.parse(account) as SyncAccount;
  } catch {
    return null;
  }
}

async function run(account: SyncAccount) {
  await stopEngine();
  const { generation } = await invoke<SyncStatusResponse>("sync_status");
  const controller = new AbortController();
  requestController = controller;
  const key = await importKey(account.key);
  const unauthorized = () => {
    if (engine !== current) return;
    stopEngine();
    syncStatusStore.setState((state) => ({ ...state, state: "error", error: "Sign in again to keep syncing." }));
  };
  const current = createSyncEngine({
    store: tauriStore(generation),
    key,
    connect: browserSocket(account, unauthorized, controller.signal),
    blobs: blobStore(account, controller.signal),
    onSignedOut: () => {
      if (engine === current) void signedOut("Signed out because the cloud data was deleted.");
    },
    merge: (updates) => Y.mergeUpdates(updates),
    onStatus: (status) => {
      if (engine === current) syncStatusStore.setState((state) => ({ ...state, ...status }));
    },
  });
  engine = current;
  activeAccount = account;
  const files = createFileSync({
    signal: controller.signal,
    generation,
    server: account.server,
    token: account.token,
    key,
    onStored: onFileStored,
    onUnauthorized: unauthorized,
  });
  fileSync = files;
  setSyncedFileHandler((fileId) => files.request(fileId));
  syncStatusStore.setState((state) => ({ ...state, account: publicAccount(account), loaded: true }));

  // Finish deletions interrupted by a crash before applying anything new.
  onRemote(await invoke<ApplyResult>("sync_reconcile", { generation }));

  const stopOutbox = await listen("sync-outbox", () => {
    current.nudge();
    files.kick();
  });
  const reconnect = () => {
    current.reconnectNow();
    files.kick();
  };
  const onVisible = () => document.visibilityState === "visible" && reconnect();
  window.addEventListener("online", reconnect);
  document.addEventListener("visibilitychange", onVisible);
  unlisten = () => {
    stopOutbox();
    window.removeEventListener("online", reconnect);
    document.removeEventListener("visibilitychange", onVisible);
  };
  current.start();
  files.kick();
}

function stopEngine() {
  requestController?.abort();
  requestController = null;
  unlisten?.();
  unlisten = null;
  const current = engine;
  const files = fileSync;
  // Capture synchronous shutdown failures too, and still stop both workers.
  const workers = [draining, Promise.resolve().then(() => { current?.stop(); return current?.idle(); }),
    Promise.resolve().then(() => files?.stop())];
  engine = null;
  fileSync = null;
  setSyncedFileHandler(null);
  activeAccount = null;
  for (const timer of reindexTimers.values()) window.clearTimeout(timer);
  reindexTimers.clear();
  // Database generation checks reject any late completion after this bound.
  // Never retain a rejected/unbounded drain as the next transition's barrier.
  draining = new Promise<void>((resolve) => {
    let ended = false;
    const timer = setTimeout(() => { ended = true; resolve(); }, 5_000);
    void Promise.allSettled(workers).then(async () => {
      if (ended) return;
      for (const timer of reindexTimers.values()) window.clearTimeout(timer);
      reindexTimers.clear();
      await Promise.allSettled([...reindexing]);
    }).finally(() => { ended = true; clearTimeout(timer); resolve(); });
  });
  return draining;
}

// This device stops syncing and forgets its sync state; its notes stay.
async function signedOut(message: string | null) {
  await stopEngine();
  await invoke("sync_disable");
  syncStatusStore.setState(() => ({
    account: null,
    loaded: true,
    state: message ? "error" : "idle",
    error: message,
    lastSyncedAt: null,
  }));
}

// Called at startup; later calls do nothing.
export function startSync() {
  started ??= serially(loadAndRun);
  return started;
}

async function loadAndRun() {
  try {
    const account = await readAccount();
    if (!account) {
      syncStatusStore.setState((state) => ({ ...state, loaded: true }));
      return;
    }
    await run(account);
  } catch (error) {
    console.error("Failed to start sync:", error);
    syncStatusStore.setState((state) => ({
      ...state,
      loaded: true,
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// Turns sync on, or signs in again with a fresh token.
export function enableSync(account: SyncAccount) {
  return serially(async () => {
    await invoke("sync_enable", { account: JSON.stringify(account) });
    await run(account);
  });
}

// Stops syncing this device. Its notes stay; the cloud copy is untouched.
export function disableSync() {
  return serially(() => signedOut(null));
}

// Deletes everything stored in the cloud for this account and signs out every
// device. Notes stay on each device; turning sync on again uploads them.
export function deleteCloudData() {
  return serially(async () => {
    const account = activeAccount;
    if (!account) throw new Error("Sync is off");
    await wipeCloudData(account.server, account.token, requestController?.signal);
    await signedOut(null);
  });
}

export function retrySync() {
  return serially(loadAndRun);
}

// Serialize the entire restore with account transitions. Stop producers before
// exclusiveWrite suspends saves, then drain already-started work before swapping.
export function restoreBackup(id: string) {
  return serially(async () => {
    try {
      await stopEngine();
      await exclusiveWrite(async () => {
        await invoke("restore_backup", { id });
        saveQueue.clear();
      }, { excludedMutation: "restore-backup", retain: true });
    } finally {
      await loadAndRun();
    }
  });
}
