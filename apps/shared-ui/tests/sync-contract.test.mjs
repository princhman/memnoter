import { test } from "node:test";
import assert from "node:assert/strict";
import contract from "../../sync/test/fixtures/protocol.json" with { type: "json" };
import { makeBlobRef, readBlobRef, fromBase64 } from "../src/lib/sync/protocol.ts";
import { deriveKey, exportKey, verifyKeyCheck, decryptBlob } from "../src/lib/sync/crypto.ts";
test("WebCrypto reads the native protocol known-answer vector and authenticates AAD", async () => {
  const v = contract.keyCheck.vector;
  const key = await deriveKey(v.passphrase, v.salt);
  assert.equal(await exportKey(key), v.key);
  assert.equal(await verifyKeyCheck(key, v.check), true);
  await assert.rejects(decryptBlob(key, "other", fromBase64(v.check)));
  assert.equal(readBlobRef(makeBlobRef(contract.blobRef.id)), contract.blobRef.id);
});
