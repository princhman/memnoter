// Talks to the sync server's HTTP API: email sign-in and the encryption
// parameters. The passphrase and the derived key never leave the device.

import { PROTOCOL_HEADER, PROTOCOL_VERSION, SYNC_CONTRACT } from "./protocol";
import { reportSyncRefusal } from "../update-required.ts";
import { syncRequest, transferTimeout, readTransfer } from "./http";
import { deriveKey, exportKey, makeKeyCheck, newSalt, verifyKeyCheck } from "./crypto";

export type SyncAccount = {
  server: string;
  email: string;
  userId: string;
  token: string;
  // The raw AES key, base64. Persisted only in the OS credential store.
  key: string;
};

type KeyInfo = { salt: string; check: string };

export const DEFAULT_SYNC_SERVER: string =
  import.meta.env?.VITE_SYNC_SERVER ?? (import.meta.env?.DEV ? "http://localhost:8787" : SYNC_CONTRACT.defaultServer);

export class SyncApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    reportSyncRefusal(message, status);
  }
}

async function api<T>(server: string, path: string, init: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}) {
  return syncRequest(`${server.replace(/\/+$/, "")}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.token ? { Authorization: `Bearer ${init.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }, async response => {
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new SyncApiError(data.error ?? `Sync server error (${response.status})`, response.status);
    return data;
  }, init.signal);
}

// In development the server returns the code instead of emailing it.
export function startSignIn(server: string, email: string) {
  return api<{ ok: true; devCode?: string }>(server, SYNC_CONTRACT.paths.authStart, { body: { email } });
}

export function verifySignIn(server: string, email: string, code: string) {
  return api<{ token: string; userId: string; email: string }>(server, SYNC_CONTRACT.paths.authVerify, { body: { email, code } });
}

export async function getKeyInfo(server: string, token: string, signal?: AbortSignal) {
  return (await api<{ key: KeyInfo | null }>(server, SYNC_CONTRACT.paths.key, { token, signal })).key;
}

// Whether the token still works; false only when the server says it doesn't.
export async function isTokenValid(server: string, token: string, signal?: AbortSignal) {
  try {
    await getKeyInfo(server, token, signal);
    return true;
  } catch (error) {
    return !(error instanceof SyncApiError && error.status === 401);
  }
}

// Encrypted images ("files") and log blobs too large for the log ("blobs").
export async function putObject(server: string, token: string, kind: "files" | "blobs", id: string, bytes: Uint8Array, signal?: AbortSignal) {
  return syncRequest(`${server.replace(/\/+$/, "")}${SYNC_CONTRACT.paths[kind]}${id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), "Content-Type": "application/octet-stream" },
    body: bytes,
  }, async response => {
    // Consume even success responses under the same cancellation deadline.
    const text = await response.text();
    if (!response.ok) throw new SyncApiError(text || `Upload failed (${response.status})`, response.status);
  }, signal, transferTimeout(bytes.length));
}

export function deleteObject(server: string, token: string, id: string, signal?: AbortSignal) {
  return api(server, SYNC_CONTRACT.paths.files + id, { method: "DELETE", token, signal });
}

// 404 is temporary; 410 is surfaced to file sync as a permanent deletion.
// null when the server has no such object (yet).
export async function getObject(server: string, token: string, kind: "files" | "blobs", id: string, signal?: AbortSignal) {
  return syncRequest(`${server.replace(/\/+$/, "")}${SYNC_CONTRACT.paths[kind]}${id}`, {
    headers: { Authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
  }, async (response, progress, requestSignal) => {
    const bytes = await readTransfer(response, progress, requestSignal);
    if (response.status === 404) return null;
    if (!response.ok) throw new SyncApiError(`Download failed (${response.status})`, response.status);
    return bytes;
  }, signal, transferTimeout());
}

export function wipeCloudData(server: string, token: string, signal?: AbortSignal) {
  return api(server, SYNC_CONTRACT.paths.vault, { method: "DELETE", token, signal });
}

// The first device creates the salt and check value; later devices must
// derive the same key from the same passphrase.
export async function unlockKey(server: string, token: string, passphrase: string): Promise<string> {
  let info = await getKeyInfo(server, token);
  if (!info) {
    const salt = newSalt();
    const key = await deriveKey(passphrase, salt);
    const proposed = { salt, check: await makeKeyCheck(key) };
    info = (await api<{ key: KeyInfo }>(server, SYNC_CONTRACT.paths.key, { method: "PUT", body: proposed, token })).key;
    if (info.salt === salt) return exportKey(key);
  }
  const key = await deriveKey(passphrase, info.salt);
  if (!(await verifyKeyCheck(key, info.check))) throw new Error("That passphrase doesn't match the one set for this account.");
  return exportKey(key);
}
