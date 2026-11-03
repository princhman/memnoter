import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_SIGNED_OUT,
  COMPACT_HINT_AFTER,
  MAX_BLOB_BYTES,
  MAX_FRAME_BYTES,
  PING,
  PONG,
  PROTOCOL_VERSION,
  fromBase64,
  isValidDocId,
  readBlobRef,
  toBase64,
  type ClientMessage,
  type ServerMessage,
  type WireEntry,
} from "../../src/lib/sync/protocol";
import type { Env } from "./env";
import { blobKey, userPrefix } from "./storage";

// Catch-up frames are split at about this many payload bytes.
const FRAME_TARGET_BYTES = 512 * 1024;
// How many stored entries between checks for documents worth compacting.
const HINT_CHECK_EVERY = 64;

type Attachment = { ready: boolean };

export type KeyInfo = { salt: string; check: string };

// One per user. Holds the user's whole encrypted log and the live connections
// of their devices. Connections use WebSocket hibernation, so an idle device
// costs no Durable Object time; pings are answered without waking it.
export class Vault extends DurableObject<Env> {
  private sql: SqlStorage;
  private storedSinceHintCheck = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Only cheap, synchronous schema setup. No index on log(doc): every
    // index entry is a billed row write, while the rare scans that need one
    // (compaction, hints) are billed as row reads, a thousand times cheaper.
    this.sql.exec(`
      create table if not exists log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        doc TEXT NOT NULL,
        data BLOB NOT NULL
      );
      create table if not exists snapshots (
        doc TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL
      );
      create table if not exists meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // Tokens issued before the cloud data was last deleted no longer work.
  private tokenAllowed(issuedAt: number) {
    const row = this.sql.exec<{ value: string }>("select value from meta where key = 'revoked_before'").toArray()[0];
    return !row || issuedAt >= Number(row.value);
  }

  // The Worker routes by user id; remember it for R2 keys.
  private bind(userId: string) {
    this.sql.exec("insert into meta (key, value) values ('user', ?) on conflict(key) do nothing", userId);
  }

  private userId(): string | null {
    return this.sql.exec<{ value: string }>("select value from meta where key = 'user'").toArray()[0]?.value ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const userId = request.headers.get("X-User-Id");
    const issuedAt = Number(request.headers.get("X-Token-Iat"));
    if (!userId || !this.tokenAllowed(issuedAt)) return new Response("Sign in again", { status: 401 });
    this.bind(userId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ready: false } satisfies Attachment);
    const headers = new Headers();
    const protocol = request.headers.get("X-Selected-Protocol");
    if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return this.fail(ws, "Binary frames are not supported");
    if (raw.length > MAX_FRAME_BYTES) return this.fail(ws, "Frame too large", true);
    let message: ClientMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return this.fail(ws, "Invalid JSON", true);
    }
    try {
      switch (message.t) {
        case "hello":
          return this.hello(ws, message.cursor, message.v);
        case "push":
          return this.push(ws, message.id, message.entries);
        case "compact":
          return this.compact(ws, message.doc, message.upTo, message.data);
        case "drop":
          if (!this.isReady(ws)) return this.fail(ws, "Say hello first");
          if (!isValidDocId(message.doc)) return this.fail(ws, "Invalid document");
          return this.drop(message.doc);
        default:
          return this.fail(ws, "Unknown message");
      }
    } catch (error) {
      console.error("Vault message failed", error);
      return this.fail(ws, error instanceof Error ? error.message : "Server error");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  // Everything after the device's cursor, then "ready". It runs without
  // awaiting, so no push can land in the middle: once a socket is ready it has
  // every entry up to head, and later entries reach it as broadcasts, in order.
  private hello(ws: WebSocket, cursor: unknown, version: unknown) {
    if (version !== PROTOCOL_VERSION) {
      return this.fail(ws, "Please update Memnoter to keep syncing", true);
    }
    const after = typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
    const rows = this.sql.exec<{ seq: number; doc: string; data: ArrayBuffer }>(
      `select seq, doc, data from (
         select seq, doc, data from snapshots where seq > ?1
         union all
         select seq, doc, data from log where seq > ?1
       ) order by seq`,
      after,
    );
    let frame: WireEntry[] = [];
    let frameBytes = 0;
    let head = after;
    for (const row of rows) {
      const data = toBase64(new Uint8Array(row.data));
      frame.push({ seq: row.seq, doc: row.doc, data });
      frameBytes += data.length;
      head = Math.max(head, row.seq);
      if (frameBytes >= FRAME_TARGET_BYTES) {
        this.send(ws, { t: "entries", entries: frame });
        frame = [];
        frameBytes = 0;
      }
    }
    if (frame.length > 0) this.send(ws, { t: "entries", entries: frame });
    ws.serializeAttachment({ ready: true } satisfies Attachment);
    this.send(ws, { t: "ready", head: Math.max(head, this.head()) });
    this.hintCompaction(ws);
  }

  private push(ws: WebSocket, id: unknown, entries: unknown) {
    if (!this.isReady(ws)) return this.fail(ws, "Say hello first");
    if (typeof id !== "number" || !Array.isArray(entries) || entries.length === 0) {
      return this.fail(ws, "Invalid push");
    }
    type Decoded = { doc: string; drop: true } | { doc: string; bytes: Uint8Array; data: string };
    const decoded: Decoded[] = [];
    for (const entry of entries) {
      if (!isValidDocId(entry?.doc)) return this.fail(ws, "Invalid entry");
      if (entry.drop === true) {
        decoded.push({ doc: entry.doc, drop: true });
        continue;
      }
      if (typeof entry.data !== "string") return this.fail(ws, "Invalid entry");
      const bytes = fromBase64(entry.data);
      if (bytes.length === 0 || bytes.length > MAX_BLOB_BYTES) return this.fail(ws, "Entry too large");
      decoded.push({ doc: entry.doc, bytes, data: entry.data });
    }

    // Synchronous writes without an await in between commit together.
    const stored: WireEntry[] = [];
    for (const entry of decoded) {
      if ("drop" in entry) {
        this.drop(entry.doc);
        continue;
      }
      const seq = this.sql
        .exec<{ seq: number }>("insert into log (doc, data) values (?, ?) returning seq", entry.doc, entry.bytes)
        .one().seq;
      stored.push({ seq, doc: entry.doc, data: entry.data });
    }

    if (stored.length > 0) {
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && this.isReady(other)) this.send(other, { t: "entries", entries: stored });
      }
    }
    this.send(ws, { t: "ack", id, seq: stored.at(-1)?.seq ?? this.head() });

    this.storedSinceHintCheck += stored.length;
    if (this.storedSinceHintCheck >= HINT_CHECK_EVERY) {
      this.storedSinceHintCheck = 0;
      this.hintCompaction(ws);
    }
  }

  // Replaces the document's log entries up to `upTo` with one snapshot. The
  // device vouches that the snapshot contains all of them: its cursor is at
  // least `upTo`. Extra, not yet pushed changes in it are harmless, because
  // applying an update twice changes nothing.
  private compact(ws: WebSocket, doc: unknown, upTo: unknown, data: unknown) {
    if (!this.isReady(ws)) return this.fail(ws, "Say hello first");
    if (!isValidDocId(doc) || typeof upTo !== "number" || typeof data !== "string") {
      return this.fail(ws, "Invalid compaction");
    }
    const bytes = fromBase64(data);
    if (bytes.length === 0 || bytes.length > MAX_BLOB_BYTES) return this.fail(ws, "Snapshot too large");
    if (upTo > this.head()) return this.fail(ws, "Snapshot is ahead of the log");
    const existing = this.sql
      .exec<{ seq: number; data: ArrayBuffer }>("select seq, data from snapshots where doc = ?", doc)
      .toArray()[0];
    if (existing && existing.seq >= upTo) {
      this.deleteBlobs([bytes]);
      return;
    }
    const replaced = [
      ...(existing ? [existing.data] : []),
      ...this.sql
        .exec<{ data: ArrayBuffer }>("select data from log where doc = ? and seq <= ? and length(data) = 33", doc, upTo)
        .toArray()
        .map((row) => row.data),
    ];
    this.sql.exec(
      "insert into snapshots (doc, seq, data) values (?1, ?2, ?3) on conflict(doc) do update set seq = ?2, data = ?3",
      doc,
      upTo,
      bytes,
    );
    this.sql.exec("delete from log where doc = ? and seq <= ?", doc, upTo);
    this.deleteBlobs(replaced.map((data) => new Uint8Array(data)));
  }

  private drop(doc: string) {
    const blobs = this.sql
      .exec<{ data: ArrayBuffer }>(
        "select data from log where doc = ?1 and length(data) = 33 union all select data from snapshots where doc = ?1",
        doc,
      )
      .toArray()
      .map((row) => new Uint8Array(row.data));
    this.sql.exec("delete from log where doc = ?", doc);
    this.sql.exec("delete from snapshots where doc = ?", doc);
    this.deleteBlobs(blobs);
  }

  // Removes the R2 objects that entries no longer in the log referred to.
  private deleteBlobs(entries: Uint8Array[]) {
    const userId = this.userId();
    if (!userId) return;
    const keys = entries.flatMap((bytes) => {
      const id = readBlobRef(bytes);
      return id ? [blobKey(userId, id)] : [];
    });
    if (keys.length === 0) return;
    this.ctx.waitUntil(this.env.FILES.delete(keys).catch((error) => console.error("Blob cleanup failed", error)));
  }

  private hintCompaction(ws: WebSocket) {
    const busy = this.sql
      .exec<{ doc: string; upTo: number }>(
        "select doc, max(seq) as upTo from log group by doc having count(*) >= ?",
        COMPACT_HINT_AFTER,
      )
      .toArray();
    for (const { doc, upTo } of busy) this.send(ws, { t: "compact-hint", doc, upTo });
  }

  private head(): number {
    return this.sql
      .exec<{ head: number }>(
        "select max(coalesce((select max(seq) from log), 0), coalesce((select max(seq) from snapshots), 0)) as head",
      )
      .one().head;
  }

  private isReady(ws: WebSocket) {
    return (ws.deserializeAttachment() as Attachment | null)?.ready === true;
  }

  private send(ws: WebSocket, message: ServerMessage) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket closed meanwhile; the device catches up when it reconnects.
    }
  }

  private fail(ws: WebSocket, message: string, fatal = false) {
    this.send(ws, { t: "error", message, fatal });
    if (fatal) ws.close(1008, message.slice(0, 100));
  }

  // Checks a token for the HTTP routes; false once it has been revoked.
  async authorize(userId: string, issuedAt: number): Promise<boolean> {
    if (!this.tokenAllowed(issuedAt)) return false;
    this.bind(userId);
    return true;
  }

  // Encryption parameters: a random salt and a value encrypted with the
  // derived key, so a new device can tell whether a passphrase is right. The
  // first device to set them wins; others must use what is stored.
  async getKeyInfo(): Promise<KeyInfo | null> {
    const row = this.sql.exec<{ value: string }>("select value from meta where key = 'key'").toArray()[0];
    return row ? (JSON.parse(row.value) as KeyInfo) : null;
  }

  async setKeyInfo(info: KeyInfo): Promise<KeyInfo> {
    const existing = await this.getKeyInfo();
    if (existing) return existing;
    this.sql.exec("insert into meta (key, value) values ('key', ?)", JSON.stringify(info));
    return info;
  }

  // Deletes everything stored for the user, in the log and in R2, and signs
  // out every device: tokens issued until now stop working.
  async wipe(): Promise<void> {
    const userId = this.userId();
    this.sql.exec("delete from log; delete from snapshots; delete from meta where key <> 'user';");
    this.sql.exec("insert into meta (key, value) values ('revoked_before', ?)", String(Date.now() + 1));
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_SIGNED_OUT, "Cloud data was deleted");
    if (!userId) return;
    let cursor: string | undefined;
    do {
      const listing = await this.env.FILES.list({ prefix: userPrefix(userId), cursor });
      if (listing.objects.length > 0) await this.env.FILES.delete(listing.objects.map((object) => object.key));
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }
}
