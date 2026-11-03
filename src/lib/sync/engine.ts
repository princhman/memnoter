// Moves encrypted Yjs updates between this device's database and the sync
// server. It knows nothing about Tauri or React: storage, the socket and the
// timers are passed in, so tests can run it against the real Worker.
//
// Guarantees:
// - An outbox entry is deleted only after the server acknowledged storing it;
//   after a dropped connection it is sent again, which is harmless because
//   applying a Yjs update twice changes nothing.
// - Remote entries are applied and the cursor advanced in one local
//   transaction (SyncStore.applyRemote), in seq order, one batch at a time.

import { decryptBlob, encryptBlob } from "./crypto";
import {
  CLOSE_SIGNED_OUT,
  MAX_BLOB_BYTES,
  makeBlobRef,
  newBlobId,
  readBlobRef,
  PING,
  PONG,
  PROTOCOL_VERSION,
  fromBase64,
  toBase64,
  type ClientMessage,
  type PushEntry,
  type ServerMessage,
  type WireEntry,
} from "./protocol";

// An entry with empty bytes asks the server to forget the document.
export type OutboxEntry = { id: number; doc: string; bytes: Uint8Array };
export type RemoteEntry = { seq: number; doc: string; bytes: Uint8Array };

export interface SyncStore {
  cursor(): Promise<number>;
  // The oldest entries first, about `limitBytes` in total (at least one).
  outbox(limitBytes: number): Promise<OutboxEntry[]>;
  // Deletes outbox entries with id <= maxId.
  ackOutbox(maxId: number): Promise<void>;
  // Applies the entries and sets the cursor, atomically.
  applyRemote(entries: RemoteEntry[], cursor: number): Promise<void>;
  setCursor(cursor: number): Promise<void>;
  // The document's full local state, or null when it no longer exists.
  snapshot(doc: string): Promise<Uint8Array | null>;
}

// Stores blobs too large for the log (R2 behind the Worker).
export interface BlobStore {
  put(id: string, blob: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array>;
}

export interface SyncSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
}

export type SyncState = "idle" | "connecting" | "syncing" | "synced" | "offline" | "error";

export type SyncStatus = {
  state: SyncState;
  error: string | null;
  lastSyncedAt: number | null;
};

export type SyncEngineOptions = {
  store: SyncStore;
  key: CryptoKey;
  connect: () => SyncSocket;
  // Without it, a change too large for the log stops sync with an error.
  blobs?: BlobStore;
  // Every device was signed out (the cloud data was deleted).
  onSignedOut?: () => void;
  // Combines several updates of one document; defaults to sending them apart.
  merge?: (updates: Uint8Array[]) => Uint8Array;
  onStatus?: (status: SyncStatus) => void;
  // Called after remote entries were applied, with the documents they touched.
  onApplied?: (docs: Set<string>) => void;
  pushDelayMs?: number;
  pingEveryMs?: number;
  now?: () => number;
};

const PUSH_BATCH_BYTES = 1024 * 1024;

// An error that retrying cannot fix, such as a wrong passphrase.
export class FatalSyncError extends Error {}
const CLOSE_POLICY = 1008;

export function createSyncEngine({
  store,
  key,
  connect,
  blobs,
  onSignedOut,
  merge,
  onStatus,
  onApplied,
  pushDelayMs = 400,
  pingEveryMs = 45_000,
  now = () => Date.now(),
}: SyncEngineOptions) {
  let socket: SyncSocket | null = null;
  let running = false;
  let ready = false;
  let inflight: { id: number; maxOutboxId: number } | null = null;
  let nextPushId = 1;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let awaitingPong = false;
  let attempts = 0;
  // Server messages are handled strictly one after another.
  let chain: Promise<void> = Promise.resolve();
  let status: SyncStatus = { state: "idle", error: null, lastSyncedAt: null };

  function setStatus(next: Partial<SyncStatus>) {
    status = { ...status, ...next };
    onStatus?.(status);
  }

  function open() {
    if (!running) return;
    setStatus({ state: "connecting" });
    ready = false;
    inflight = null;
    const current = connect();
    socket = current;
    current.onopen = () => {
      if (socket !== current) return;
      attempts = 0;
      setStatus({ state: "syncing", error: null });
      enqueue(async () => {
        const cursor = await store.cursor();
        send({ t: "hello", cursor, v: PROTOCOL_VERSION });
      });
      startPing(current);
    };
    current.onmessage = (data) => {
      if (socket !== current) return;
      if (data === PONG) {
        awaitingPong = false;
        return;
      }
      let message: ServerMessage;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      enqueue(() => handle(message));
    };
    current.onclose = (code, reason) => {
      if (socket !== current) return;
      socket = null;
      ready = false;
      inflight = null;
      stopPing();
      if (!running) return;
      if (code === CLOSE_SIGNED_OUT) {
        stopEngine();
        setStatus({ state: "error", error: "Signed out because the cloud data was deleted." });
        onSignedOut?.();
        return;
      }
      if (code === CLOSE_POLICY) {
        setStatus({ state: "error", error: reason || "The sync server refused this device" });
        return;
      }
      setStatus({ state: "offline" });
      scheduleReconnect();
    };
  }

  function enqueue(task: () => Promise<void>) {
    chain = chain.then(task).catch((error) => {
      console.error("Sync failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof FatalSyncError) {
        stopEngine();
        setStatus({ state: "error", error: message });
        return;
      }
      // Start over from the stored cursor; nothing was acknowledged wrongly.
      const current = socket;
      socket = null;
      current?.close(4000, "client error");
      setStatus({ state: "offline", error: message });
      scheduleReconnect();
    });
  }

  function send(message: ClientMessage) {
    socket?.send(JSON.stringify(message));
  }

  async function handle(message: ServerMessage) {
    switch (message.t) {
      case "entries":
        return applyEntries(message.entries);
      case "ready": {
        const cursor = await store.cursor();
        if (message.head > cursor) await store.setCursor(message.head);
        ready = true;
        setStatus({ state: "synced", lastSyncedAt: now() });
        schedulePush(0);
        return;
      }
      case "ack": {
        if (!inflight || inflight.id !== message.id) return;
        await store.ackOutbox(inflight.maxOutboxId);
        // Every entry before this one already reached this socket and was
        // applied: the server handles messages one at a time and broadcasts
        // each push before acknowledging the next.
        const cursor = await store.cursor();
        if (message.seq > cursor) await store.setCursor(message.seq);
        inflight = null;
        setStatus({ state: "synced", lastSyncedAt: now() });
        schedulePush(0);
        return;
      }
      case "compact-hint":
        return compact(message.doc, message.upTo);
      case "error":
        if (message.fatal) throw new FatalSyncError(message.message);
        // A rejected push is never acknowledged; reconnect and try again.
        throw new Error(message.message);
    }
  }

  async function applyEntries(wire: WireEntry[]) {
    if (wire.length === 0) return;
    const entries: RemoteEntry[] = [];
    for (const entry of wire) {
      let bytes: Uint8Array;
      let blob = fromBase64(entry.data);
      const ref = readBlobRef(blob);
      if (ref) {
        if (!blobs) throw new FatalSyncError("This device can't download large changes.");
        blob = await blobs.get(ref);
      }
      try {
        bytes = await decryptBlob(key, entry.doc, blob);
      } catch {
        throw new FatalSyncError("Synced data could not be decrypted. Check your sync passphrase.");
      }
      entries.push({ seq: entry.seq, doc: entry.doc, bytes });
    }
    const cursor = Math.max(await store.cursor(), ...entries.map((entry) => entry.seq));
    await store.applyRemote(entries, cursor);
    onApplied?.(new Set(entries.map((entry) => entry.doc)));
    if (ready) setStatus({ state: "synced", lastSyncedAt: now() });
  }

  async function compact(doc: string, upTo: number) {
    // Read the cursor before the state: the state only grows, so it then
    // contains every entry the cursor vouches for.
    const cursor = await store.cursor();
    if (cursor < upTo) return;
    const state = await store.snapshot(doc);
    if (!state) {
      send({ t: "drop", doc });
      return;
    }
    const blob = await storable(await encryptBlob(key, doc, state));
    if (!blob) return;
    send({ t: "compact", doc, upTo: cursor, data: toBase64(blob) });
  }

  // The blob itself when it fits in the log, otherwise a reference to a copy
  // uploaded to the blob store; null when neither is possible.
  async function storable(blob: Uint8Array): Promise<Uint8Array | null> {
    if (blob.length <= MAX_BLOB_BYTES) return blob;
    if (!blobs) return null;
    const id = newBlobId();
    await blobs.put(id, blob);
    return makeBlobRef(id);
  }

  function schedulePush(delay = pushDelayMs) {
    if (!ready || inflight || pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      enqueue(push);
    }, delay);
  }

  async function push() {
    if (!ready || inflight || !socket) return;
    const outbox = await store.outbox(PUSH_BATCH_BYTES);
    if (outbox.length === 0) return;

    // One blob per document, in the order documents first appear, so a new
    // module's vault entry still precedes its content. A deleted document
    // sends only the drop: its earlier changes would be dropped with it.
    const byDoc = new Map<string, Uint8Array[]>();
    const dropped = new Set<string>();
    for (const entry of outbox) {
      if (entry.bytes.length === 0) {
        dropped.add(entry.doc);
        byDoc.set(entry.doc, []);
        continue;
      }
      const list = byDoc.get(entry.doc) ?? [];
      list.push(entry.bytes);
      byDoc.set(entry.doc, list);
    }
    const entries: PushEntry[] = [];
    for (const [doc, updates] of byDoc) {
      if (dropped.has(doc)) {
        entries.push({ doc, drop: true });
        continue;
      }
      let encrypted: Uint8Array[] | null = null;
      if (merge && updates.length > 1) {
        const merged = await encryptBlob(key, doc, merge(updates));
        if (merged.length <= MAX_BLOB_BYTES) encrypted = [merged];
      }
      encrypted ??= await Promise.all(updates.map((update) => encryptBlob(key, doc, update)));
      for (const blob of encrypted) {
        const data = await storable(blob);
        if (!data) throw new FatalSyncError("A note change is too large to sync.");
        entries.push({ doc, data: toBase64(data) });
      }
    }
    const id = nextPushId++;
    inflight = { id, maxOutboxId: outbox[outbox.length - 1].id };
    setStatus({ state: "syncing" });
    send({ t: "push", id, entries });
  }

  function startPing(current: SyncSocket) {
    stopPing();
    awaitingPong = false;
    pingTimer = setInterval(() => {
      if (awaitingPong) {
        // No answer to the last ping: the connection is dead.
        current.close(4002, "ping timeout");
        current.onclose?.(4002, "ping timeout");
        return;
      }
      awaitingPong = true;
      current.send(PING);
    }, pingEveryMs);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function stopEngine() {
    running = false;
    if (pushTimer) clearTimeout(pushTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    pushTimer = reconnectTimer = null;
    stopPing();
    const current = socket;
    socket = null;
    ready = false;
    inflight = null;
    current?.close(1000, "stopped");
  }

  function scheduleReconnect(delay?: number) {
    if (!running || reconnectTimer) return;
    attempts += 1;
    const wait = delay ?? Math.min(1000 * 2 ** (attempts - 1), 30_000) * (0.75 + Math.random() * 0.5);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, wait);
  }

  return {
    start() {
      if (running) return;
      running = true;
      open();
    },
    stop() {
      stopEngine();
      setStatus({ state: "idle" });
    },
    // Local changes were written to the outbox.
    nudge() {
      schedulePush();
    },
    // The network came back or the app returned to the foreground.
    reconnectNow() {
      if (!running) return;
      if (socket) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      attempts = 0;
      open();
    },
    // Resolves once every queued server message has been handled.
    idle() {
      return chain;
    },
    status: () => status,
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
