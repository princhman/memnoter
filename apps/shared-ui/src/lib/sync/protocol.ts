import contract from "../../../../sync/test/fixtures/protocol.json" with { type: "json" };
export { contract as SYNC_CONTRACT };
// Wire protocol between the app and the sync server, shared by both sides.
//
// The server stores an append-only log of opaque, end-to-end encrypted blobs,
// each tagged with the document it belongs to ("vault" for the module list,
// otherwise a module id). It never decodes them. Every stored blob gets a
// sequence number; a device keeps the highest one it has applied as its cursor
// and asks for everything after it.
//
// Frames are JSON text; `data` fields are base64.

export const PROTOCOL_VERSION = contract.version;
// WebSocket subprotocols: this one, plus "auth.<token>", because browsers
// cannot set headers on a WebSocket request.
export const SYNC_PROTOCOL = contract.protocol;
export const AUTH_PROTOCOL_PREFIX = contract.authPrefix;

// Largest encrypted blob the server accepts: a Durable Object SQLite row holds
// at most 2 MB. Larger blobs will go to R2 (phase 2).
export const MAX_BLOB_BYTES = contract.MAX_BLOB_BYTES;
// Largest frame the server accepts (Workers WebSocket messages max at 32 MiB).
export const MAX_FRAME_BYTES = contract.MAX_FRAME_BYTES;

// The server asks a device to upload a snapshot once a document has this many
// log entries since its last one.
export const COMPACT_HINT_AFTER = 400;

// Sent as-is and answered by the server without waking the Durable Object.
export const PING = contract.PING;
export const PONG = contract.PONG;

export type WireEntry = { seq: number; doc: string; data: string };

// A pushed entry stores a blob, or with `drop` deletes everything stored for
// the document (it was deleted on a device).
export type PushEntry = { doc: string; data: string } | { doc: string; drop: true };

export type ClientMessage =
  | { t: "hello"; cursor: number; v: number }
  // `id` is chosen by the client and echoed in the ack.
  | { t: "push"; id: number; entries: PushEntry[] }
  // A snapshot that contains every entry of `doc` up to and including `upTo`.
  | { t: "compact"; doc: string; upTo: number; data: string }
  // The document was deleted; the server forgets its entries.
  | { t: "drop"; doc: string };

export type ServerMessage =
  // Entries are in ascending seq order. Snapshots carry the seq they cover.
  | { t: "entries"; entries: WireEntry[] }
  // Catch-up after hello is complete: the device now has everything to `head`.
  | { t: "ready"; head: number }
  // `seq` is the highest sequence assigned to the pushed entries.
  | { t: "ack"; id: number; seq: number }
  | { t: "compact-hint"; doc: string; upTo: number }
  | { t: "error"; message: string; fatal?: boolean };

// Close code: the account's cloud data was deleted and every device signed out.
export const CLOSE_SIGNED_OUT = contract.closeSignedOut;

// A blob too large for the log is stored in R2 and the log holds a reference:
// one byte 2 and the 32 hex characters of its id, unencrypted, so the server
// can delete the object when the entry is compacted or dropped. Encrypted
// blobs always start with byte 1.
const BLOB_REF_FORMAT = 2;
const BLOB_REF_LENGTH = 33;

export function makeBlobRef(id: string): Uint8Array {
  if (!isValidBlobId(id)) throw new Error("Invalid blob id");
  const bytes = new Uint8Array(BLOB_REF_LENGTH);
  bytes[0] = BLOB_REF_FORMAT;
  bytes.set(new TextEncoder().encode(id), 1);
  return bytes;
}

export function readBlobRef(bytes: Uint8Array): string | null {
  if (bytes.length !== BLOB_REF_LENGTH || bytes[0] !== BLOB_REF_FORMAT) return null;
  const id = new TextDecoder().decode(bytes.subarray(1));
  return isValidBlobId(id) ? id : null;
}

export function newBlobId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isValidBlobId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}

// Image file ids are UUIDs.
export function isValidFileId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-fA-F-]{36}$/.test(id);
}

// Largest image the server accepts.
export const MAX_FILE_BYTES = contract.MAX_FILE_BYTES;

// Largest blob stored in R2 instead of the log.
export const MAX_LARGE_BLOB_BYTES = contract.MAX_LARGE_BLOB_BYTES;

export function isValidDocId(doc: unknown): doc is string {
  return typeof doc === "string" && doc.length > 0 && doc.length <= 64 && /^[A-Za-z0-9_-]+$/.test(doc);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const CLOSE_POLICY = contract.closePolicy;
export const PUSH_BATCH_BYTES = contract.PUSH_BATCH_BYTES;
export const PASSPHRASE_MIN_LENGTH = contract.PASSPHRASE_MIN_LENGTH;
