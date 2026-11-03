// Talks to the sync server's HTTP API: email sign-in and the encryption
// parameters. The passphrase and the derived key never leave the device.

import { deriveKey, exportKey, makeKeyCheck, newSalt, verifyKeyCheck } from "./crypto";

export type SyncAccount = {
  server: string;
  email: string;
  userId: string;
  token: string;
  // The raw AES key, base64. Stored locally next to the plaintext notes.
  key: string;
};

type KeyInfo = { salt: string; check: string };

export const DEFAULT_SYNC_SERVER: string =
  import.meta.env.VITE_SYNC_SERVER ?? (import.meta.env.DEV ? "http://localhost:8787" : "https://sync.memnoter.com");

export class SyncApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(server: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  let response: Response;
  try {
    response = await fetch(`${server.replace(/\/+$/, "")}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new SyncApiError("Can't reach the sync server. Check your connection.", 0);
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new SyncApiError(data.error ?? `Sync server error (${response.status})`, response.status);
  return data;
}

// In development the server returns the code instead of emailing it.
export function startSignIn(server: string, email: string) {
  return api<{ ok: true; devCode?: string }>(server, "/v1/auth/start", { body: { email } });
}

export function verifySignIn(server: string, email: string, code: string) {
  return api<{ token: string; userId: string; email: string }>(server, "/v1/auth/verify", { body: { email, code } });
}

export async function getKeyInfo(server: string, token: string) {
  return (await api<{ key: KeyInfo | null }>(server, "/v1/key", { token })).key;
}

// Whether the token still works; false only when the server says it doesn't.
export async function isTokenValid(server: string, token: string) {
  try {
    await getKeyInfo(server, token);
    return true;
  } catch (error) {
    return !(error instanceof SyncApiError && error.status === 401);
  }
}

// Encrypted images ("files") and log blobs too large for the log ("blobs").
export async function putObject(server: string, token: string, kind: "files" | "blobs", id: string, bytes: Uint8Array) {
  let response: Response;
  try {
    response = await fetch(`${server.replace(/\/+$/, "")}/v1/${kind}/${id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: bytes,
    });
  } catch {
    throw new SyncApiError("Can't reach the sync server.", 0);
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new SyncApiError(data.error ?? `Upload failed (${response.status})`, response.status);
  }
}

// null when the server has no such object (yet).
export async function getObject(server: string, token: string, kind: "files" | "blobs", id: string) {
  let response: Response;
  try {
    response = await fetch(`${server.replace(/\/+$/, "")}/v1/${kind}/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new SyncApiError("Can't reach the sync server.", 0);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new SyncApiError(`Download failed (${response.status})`, response.status);
  return new Uint8Array(await response.arrayBuffer());
}

export function wipeCloudData(server: string, token: string) {
  return api(server, "/v1/vault", { method: "DELETE", token });
}

// The first device creates the salt and check value; later devices must
// derive the same key from the same passphrase.
export async function unlockKey(server: string, token: string, passphrase: string): Promise<string> {
  let info = await getKeyInfo(server, token);
  if (!info) {
    const salt = newSalt();
    const key = await deriveKey(passphrase, salt);
    const proposed = { salt, check: await makeKeyCheck(key) };
    info = (await api<{ key: KeyInfo }>(server, "/v1/key", { method: "PUT", body: proposed, token })).key;
    if (info.salt === salt) return exportKey(key);
  }
  const key = await deriveKey(passphrase, info.salt);
  if (!(await verifyKeyCheck(key, info.check))) throw new Error("That passphrase doesn't match the one set for this account.");
  return exportKey(key);
}
