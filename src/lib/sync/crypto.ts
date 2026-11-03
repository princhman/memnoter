// End-to-end encryption for synced data. The key is derived from the user's
// sync passphrase and never leaves their devices; the server stores only
// ciphertext plus a random salt.
//
// Blob layout: [format 1][12-byte IV][AES-256-GCM ciphertext + tag]. The
// document id is authenticated data, so the server cannot move a blob from one
// note into another without decryption failing.

import { fromBase64, toBase64 } from "./protocol";

const FORMAT = 1;
const IV_BYTES = 12;
// OWASP's 2023+ recommendation for PBKDF2-HMAC-SHA256.
export const PBKDF2_ITERATIONS = 600_000;
const CHECK_DOC = "key-check";
const CHECK_TEXT = "memnoter-key-check";

const encoder = new TextEncoder();

export function newSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(passphrase: string, salt: string, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase.normalize("NFKC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer));
}

export function importKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

export async function encryptBlob(key: CryptoKey, doc: string, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(doc) }, key, plain),
  );
  const blob = new Uint8Array(1 + IV_BYTES + cipher.length);
  blob[0] = FORMAT;
  blob.set(iv, 1);
  blob.set(cipher, 1 + IV_BYTES);
  return blob;
}

export async function decryptBlob(key: CryptoKey, doc: string, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 1 + IV_BYTES + 16 || blob[0] !== FORMAT) throw new Error("Unknown encrypted format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(1, 1 + IV_BYTES), additionalData: encoder.encode(doc) },
    key,
    blob.subarray(1 + IV_BYTES),
  );
  return new Uint8Array(plain);
}

// Stored next to the salt so another device can check a passphrase.
export async function makeKeyCheck(key: CryptoKey): Promise<string> {
  return toBase64(await encryptBlob(key, CHECK_DOC, encoder.encode(CHECK_TEXT)));
}

export async function verifyKeyCheck(key: CryptoKey, check: string): Promise<boolean> {
  try {
    const plain = await decryptBlob(key, CHECK_DOC, fromBase64(check));
    return new TextDecoder().decode(plain) === CHECK_TEXT;
  } catch {
    return false;
  }
}
