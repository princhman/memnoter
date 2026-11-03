import { SELF } from "cloudflare:test";
import * as Y from "yjs";
import type { BlobStore, OutboxEntry, RemoteEntry, SyncSocket, SyncStore } from "../../src/lib/sync/engine";

export const BASE = "https://sync.test";

export async function signIn(email: string) {
  const start = await SELF.fetch(`${BASE}/v1/auth/start`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  const { devCode } = await start.json<{ devCode: string }>();
  const verify = await SELF.fetch(`${BASE}/v1/auth/verify`, {
    method: "POST",
    body: JSON.stringify({ email, code: devCode }),
  });
  return verify.json<{ token: string; userId: string }>();
}

// A WebSocket to the Worker, wrapped in the engine's socket interface.
export function connector(token: string) {
  return (): SyncSocket => {
    const socket: SyncSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: () => {
        throw new Error("Not open yet");
      },
      close: () => {},
    };
    void (async () => {
      const response = await SELF.fetch(`${BASE}/v1/sync`, {
        headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `memnoter.v1, auth.${token}` },
      });
      const ws = response.webSocket;
      if (!ws) {
        socket.onclose?.(1006, `HTTP ${response.status}`);
        return;
      }
      ws.accept();
      socket.send = (data) => ws.send(data);
      socket.close = (code, reason) => ws.close(code, reason);
      ws.addEventListener("message", (event) => socket.onmessage?.(event.data as string));
      ws.addEventListener("close", (event) => socket.onclose?.(event.code, event.reason));
      socket.onopen?.();
    })();
    return socket;
  };
}

// A device's storage in memory: one Y.Doc per document plus an outbox.
export class MemoryDevice implements SyncStore {
  docs = new Map<string, Y.Doc>();
  outboxEntries: OutboxEntry[] = [];
  nextId = 1;
  position = 0;

  doc(name: string) {
    let doc = this.docs.get(name);
    if (!doc) {
      doc = new Y.Doc();
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "remote") this.outboxEntries.push({ id: this.nextId++, doc: name, bytes: update });
      });
      this.docs.set(name, doc);
    }
    return doc;
  }

  text(name: string) {
    return this.doc(name).getText("t").toString();
  }

  async cursor() {
    return this.position;
  }
  async outbox(limitBytes: number) {
    const batch: OutboxEntry[] = [];
    let bytes = 0;
    for (const entry of this.outboxEntries) {
      if (batch.length > 0 && bytes + entry.bytes.length > limitBytes) break;
      batch.push(entry);
      bytes += entry.bytes.length;
    }
    return batch;
  }
  async ackOutbox(maxId: number) {
    this.outboxEntries = this.outboxEntries.filter((entry) => entry.id > maxId);
  }
  async applyRemote(entries: RemoteEntry[], cursor: number) {
    for (const entry of entries) Y.applyUpdate(this.doc(entry.doc), entry.bytes, "remote");
    this.position = cursor;
  }
  async setCursor(cursor: number) {
    this.position = cursor;
  }
  async snapshot(name: string) {
    const doc = this.docs.get(name);
    return doc ? Y.encodeStateAsUpdate(doc) : null;
  }
  // The document was deleted here: tell the server to forget it.
  drop(name: string) {
    this.docs.delete(name);
    this.outboxEntries.push({ id: this.nextId++, doc: name, bytes: new Uint8Array() });
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The engine's large-blob store, backed by the Worker's /v1/blobs routes.
export function blobStore(token: string): BlobStore {
  return {
    async put(id, blob) {
      const response = await SELF.fetch(`${BASE}/v1/blobs/${id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": String(blob.length) },
        body: blob,
      });
      if (!response.ok) throw new Error(`put ${response.status}`);
    },
    async get(id) {
      const response = await SELF.fetch(`${BASE}/v1/blobs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`get ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
