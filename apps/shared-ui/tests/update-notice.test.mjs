import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyncEngine } from "../src/lib/sync/engine.ts";
import { deleteObject, putObject, getObject, SyncApiError } from "../src/lib/sync/account.ts";
import { updateRequiredStore } from "../src/lib/update-required.ts";
import { UPDATE_REQUIRED_MESSAGE, PROTOCOL_HEADER, PROTOCOL_VERSION } from "../src/lib/sync/protocol.ts";
import { newerRelease, latestRelease } from "../src/lib/releases.ts";

test("fatal protocol refusal shows a sticky update notice, other fatal errors do not", async () => {
  for (const [message, expected] of [["Wrong passphrase", false], [UPDATE_REQUIRED_MESSAGE, true]]) {
    updateRequiredStore.setState(() => false);
    const socket = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null };
    const engine = createSyncEngine({ store: { cursor: async () => 0 }, key: {}, connect: () => socket });
    engine.start();
    socket.onmessage(JSON.stringify({ t: "error", fatal: true, message }));
    await engine.idle();
    assert.equal(engine.status().state, "error");
    assert.equal(updateRequiredStore.state, expected);
    engine.stop();
    assert.equal(updateRequiredStore.state, expected);
  }
});

test("file and blob requests carry protocol and surface 426 as an update notice", async () => {
  const original = globalThis.fetch;
  try {
    for (const operation of [() => deleteObject("https://sync.test", "token", "id"), () => putObject("https://sync.test", "token", "blobs", "id", new Uint8Array([1])), () => getObject("https://sync.test", "token", "files", "id")]) {
      updateRequiredStore.setState(() => false);
      globalThis.fetch = async (_url, init) => {
        assert.equal(init.headers.Authorization, "Bearer token");
        assert.equal(init.headers[PROTOCOL_HEADER], String(PROTOCOL_VERSION));
        return Response.json({ error: UPDATE_REQUIRED_MESSAGE }, { status: 426 });
      };
      await assert.rejects(operation, error => error instanceof SyncApiError && error.status === 426);
      assert.equal(updateRequiredStore.state, true);
    }
  } finally { globalThis.fetch = original; }
});

test("release comparisons use numeric stable versions", () => {
  for (const [current, latest, expected] of [["0.1.5", "v0.1.6", true], ["0.1.9", "v0.1.10", true], ["1.0.0", "v0.99.99", false], ["0.1.5", "0.1.5", false], ["0.1.5", "v0.1.6-beta.1", false], ["bad", "v1.0.0", false], ["1.0.0+build", "v1.0.1", true]]) assert.equal(newerRelease(current, latest), expected);
});

test("release checks cache daily, and offline/rate-limited launches fail silently", async () => {
  const original = globalThis.fetch;
  const storage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ tag_name: "v0.1.6" }); };
    assert.equal(await latestRelease("0.1.5"), "v0.1.6");
    assert.equal(await latestRelease("0.1.5"), "v0.1.6");
    assert.equal(calls, 1);
    for (const response of [() => { throw new Error("offline"); }, () => new Response(null, { status: 403 }), () => new Response(null, { status: 429 })]) {
      values.clear(); calls = 0;
      globalThis.fetch = async () => { calls++; return response(); };
      assert.equal(await latestRelease("0.1.5"), null);
      assert.equal(await latestRelease("0.1.5"), null);
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = original; globalThis.localStorage = storage; }
});
