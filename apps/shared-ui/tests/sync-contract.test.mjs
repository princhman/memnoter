import { test } from "node:test";
import assert from "node:assert/strict";
import contract from "../../sync/test/fixtures/protocol.json" with { type: "json" };
import { makeBlobRef, readBlobRef, fromBase64 } from "../src/lib/sync/protocol.ts";
import { deriveKey, exportKey, verifyKeyCheck, decryptBlob } from "../src/lib/sync/crypto.ts";
import { createSyncEngine } from "../src/lib/sync/engine.ts";

test("WebCrypto reads the native protocol known-answer vector and authenticates AAD", async () => {
  const v = contract.keyCheck.vector;
  const key = await deriveKey(v.passphrase, v.salt);
  assert.equal(await exportKey(key), v.key);
  assert.equal(await verifyKeyCheck(key, v.check), true);
  await assert.rejects(decryptBlob(key, "other", fromBase64(v.check)));
  assert.equal(readBlobRef(makeBlobRef(contract.blobRef.id)), contract.blobRef.id);
});

test("a deferred snapshot leaves the server document alone", async () => {
  const { passphrase, salt } = contract.keyCheck.vector;
  const key = await deriveKey(passphrase, salt);
  const sent = [];
  const socket = { send: message => sent.push(JSON.parse(message)), close() {} };
  const store = {
    cursor: async () => 1,
    snapshot: async doc => doc === "moving-note" ? new Uint8Array() : null,
  };
  const engine = createSyncEngine({ store, key, connect: () => socket });
  engine.start();
  try {
    for (const doc of ["moving-note", "deleted-note"]) {
      socket.onmessage(JSON.stringify({ t: "compact-hint", doc, upTo: 1 }));
    }
    await engine.idle();
    assert.deepEqual(sent, [{ t: "drop", doc: "deleted-note" }]);
  } finally {
    engine.stop();
  }
});
