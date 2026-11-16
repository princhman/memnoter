import { expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { BASE, signIn, connector, MemoryDevice, waitFor } from "./helpers";
import { createSyncEngine } from "../../shared-ui/src/lib/sync/engine";
import { importKey } from "../../shared-ui/src/lib/sync/crypto";
import { PROTOCOL_VERSION, makeBlobRef, toBase64 } from "../../shared-ui/src/lib/sync/protocol";

it("counts immutable uploads once, rejects concurrent overflow, frees deleted space and leaves note sync running", async () => {
  const { token } = await signIn("quota@example.com");
  const headers = { Authorization: `Bearer ${token}`, "X-Memnoter-Protocol-Version": String(PROTOCOL_VERSION) };
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const put = (id: string, bytes = 600, kind = "files") => SELF.fetch(`${BASE}/v1/${kind}/${id}`, {
    method: "PUT", headers: { ...headers, "Content-Length": String(bytes) }, body: new Uint8Array(bytes),
  });
  const usage = async () => (await SELF.fetch(`${BASE}/v1/usage`, { headers })).json();
  expect(await usage()).toEqual({ plan: "free", usedBytes: 0, limitBytes: 1000 });
  const responses = await Promise.all(ids.slice(0, 2).map(id => put(id)));
  expect(responses.map(r => r.status).sort()).toEqual([200, 413]);
  const stored = ids[responses[0].ok ? 0 : 1];
  const rejected = responses.find(r => r.status === 413)!;
  expect(await rejected.json()).toEqual({ error: "quota_exceeded", used: 600, limit: 1000 });
  expect((await put(stored)).status).toBe(200);
  expect(await usage()).toEqual({ plan: "free", usedBytes: 600, limitBytes: 1000 });
  expect((await put(ids[2], 500)).status).toBe(413);
  expect((await SELF.fetch(`${BASE}/v1/files/${ids[2]}`, { headers })).status).toBe(404);

  const store = new MemoryDevice();
  const engine = createSyncEngine({ store, key: await importKey(btoa("a".repeat(32))), connect: connector(token), pushDelayMs: 5 });
  try {
    engine.start();
    await waitFor(() => engine.status().state === "synced");
    store.doc("note").getText("t").insert(0, "Notes remain free");
    engine.nudge();
    await waitFor(() => store.outboxEntries.length === 0);
  } finally { engine.stop(); }
  for (let i = 0; i < 2; i++) expect((await SELF.fetch(`${BASE}/v1/files/${stored}`, { method: "DELETE", headers })).status).toBe(200);
  expect(await usage()).toEqual({ plan: "free", usedBytes: 0, limitBytes: 1000 });
  expect((await put(ids[2])).status).toBe(200);
});

it("recounts existing prefixes, excludes deletion markers, protects admin operations and retains paid plans on wipe", async () => {
  const { token, userId } = await signIn("quota-admin@example.com");
  await env.FILES.put(`${userId}/files/${crypto.randomUUID()}`, new Uint8Array(700));
  await env.FILES.put(`${userId}/blobs/${"a".repeat(32)}`, new Uint8Array(500));
  await env.FILES.put(`${userId}/gone/${crypto.randomUUID()}`, new Uint8Array(20));
  const admin = (operation: string, auth = "test-admin", plan = "founder") => SELF.fetch(`${BASE}/v1/admin/users/${userId}/${operation}`, {
    method: "POST", headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify({ plan }),
  });
  expect((await admin("plan", token)).status).toBe(403);
  expect(await (await admin("recompute")).json()).toEqual({ plan: "free", usedBytes: 1200, limitBytes: 1000 });
  expect(await (await admin("plan")).json()).toEqual({ plan: "founder", usedBytes: 1200, limitBytes: null });
  const headers = { Authorization: `Bearer ${token}` };
  expect((await SELF.fetch(`${BASE}/v1/files/${crypto.randomUUID()}`, { method: "PUT", headers: { ...headers, "Content-Length": "1500" }, body: new Uint8Array(1500) })).status).toBe(200);
  expect((await SELF.fetch(`${BASE}/v1/vault`, { method: "DELETE", headers })).status).toBe(200);
  expect(await (await admin("recompute")).json()).toEqual({ plan: "founder", usedBytes: 0, limitBytes: null });
});

it("accounts for large note blobs and decrements them on log garbage collection", async () => {
  const { token } = await signIn("quota-blobs@example.com");
  const headers = { Authorization: `Bearer ${token}` };
  const id = "b".repeat(32);
  expect((await SELF.fetch(`${BASE}/v1/blobs/${id}`, { method: "PUT", headers: { ...headers, "Content-Length": "1500" }, body: new Uint8Array(1500) })).status).toBe(200);
  const socket = connector(token)();
  const messages: { t: string }[] = [];
  socket.onmessage = data => messages.push(JSON.parse(data));
  socket.onopen = () => socket.send(JSON.stringify({ t: "hello", cursor: 0, v: PROTOCOL_VERSION }));
  try {
    await waitFor(() => messages.some(m => m.t === "ready"));
    socket.send(JSON.stringify({ t: "push", id: 1, entries: [{ doc: "note", data: toBase64(makeBlobRef(id)) }] }));
    await waitFor(() => messages.some(m => m.t === "ack"));
    socket.send(JSON.stringify({ t: "drop", doc: "note" }));
    await waitFor(async () => (await (await SELF.fetch(`${BASE}/v1/usage`, { headers })).json<{ usedBytes: number }>()).usedBytes === 0);
  } finally { socket.close(); }
});


it("repairs usage after an interrupted R2 mutation before admitting another file", async () => {
  const { token, userId } = await signIn("quota-repair@example.com");
  const headers = { Authorization: `Bearer ${token}` };
  await SELF.fetch(`${BASE}/v1/usage`, { headers });
  // Simulate R2 completing just before a DO restart loses the counter update.
  await env.FILES.put(`${userId}/files/${crypto.randomUUID()}`, new Uint8Array(800));
  await runInDurableObject(env.VAULT.getByName(userId), async (_vault, state) => {
    state.storage.sql.exec("insert into meta (key, value) values ('usage_dirty', '1')");
  });
  const response = await SELF.fetch(`${BASE}/v1/files/${crypto.randomUUID()}`, {
    method: "PUT", headers: { ...headers, "Content-Length": "300" }, body: new Uint8Array(300),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "quota_exceeded", used: 800, limit: 1000 });
});
