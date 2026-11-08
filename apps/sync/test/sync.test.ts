import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { deriveKey, encryptBlob, newSalt } from "../../shared-ui/src/lib/sync/crypto";
import { createSyncEngine, type SyncEngine } from "../../shared-ui/src/lib/sync/engine";
import { toBase64, type ServerMessage } from "../../shared-ui/src/lib/sync/protocol";
import { BASE, MemoryDevice, blobStore, connector, signIn, waitFor } from "./helpers";

const salt = newSalt();
// Few iterations: the tests check behaviour, not key strength.
const keyPromise = deriveKey("correct horse battery staple", salt, 1000);

async function device(token: string, key?: CryptoKey) {
  const store = new MemoryDevice();
  const signedOut = { value: false };
  const engine = createSyncEngine({
    store,
    key: key ?? (await keyPromise),
    connect: connector(token),
    blobs: blobStore(token),
    onSignedOut: () => {
      signedOut.value = true;
    },
    merge: (updates) => Y.mergeUpdates(updates),
    pushDelayMs: 10,
  });
  return { store, engine, signedOut };
}

function synced(engine: SyncEngine) {
  return () => engine.status().state === "synced";
}

// A raw socket for protocol-level checks.
async function rawSocket(token: string) {
  const response = await SELF.fetch(`${BASE}/v1/sync`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `memnoter.v1, auth.${token}` },
  });
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("memnoter.v1");
  const ws = response.webSocket!;
  ws.accept();
  const received: ServerMessage[] = [];
  ws.addEventListener("message", (event) => {
    if (event.data !== "pong") received.push(JSON.parse(event.data as string));
  });
  return { ws, received, send: (message: unknown) => ws.send(JSON.stringify(message)) };
}

describe("sync between devices", () => {
  it("merges concurrent edits on two devices", async () => {
    const { token } = await signIn("two@example.com");
    const a = await device(token);
    const b = await device(token);
    a.engine.start();
    b.engine.start();
    await waitFor(synced(a.engine));
    await waitFor(synced(b.engine));

    a.store.doc("note-1").getText("t").insert(0, "Hello");
    a.engine.nudge();
    await waitFor(() => b.store.text("note-1") === "Hello");

    // Both edit at once; Yjs merges without conflicts.
    a.store.doc("note-1").getText("t").insert(5, " world");
    b.store.doc("note-1").getText("t").insert(0, ">> ");
    a.engine.nudge();
    b.engine.nudge();
    await waitFor(() => a.store.text("note-1") === b.store.text("note-1") && a.store.text("note-1").length === 14);
    expect(a.store.text("note-1")).toBe(">> Hello world");
    await waitFor(() => a.store.outboxEntries.length === 0 && b.store.outboxEntries.length === 0);

    a.engine.stop();
    b.engine.stop();
  });

  it("catches up a device that was offline and merges what it did meanwhile", async () => {
    const { token } = await signIn("offline@example.com");
    const a = await device(token);
    a.engine.start();
    await waitFor(synced(a.engine));
    for (let i = 0; i < 50; i++) {
      a.store.doc(`note-${i % 5}`).getText("t").insert(0, `${i};`);
      a.engine.nudge();
    }
    await waitFor(() => a.store.outboxEntries.length === 0);

    // Edited offline before ever connecting.
    const c = await device(token);
    c.store.doc("note-0").getText("t").insert(0, "offline;");
    c.engine.start();
    await waitFor(() => c.store.outboxEntries.length === 0 && synced(c.engine)());
    for (let i = 0; i < 5; i++) {
      await waitFor(() => c.store.text(`note-${i}`).length > 0);
    }
    await waitFor(() => a.store.text("note-0").includes("offline;"));
    expect(c.store.text("note-0")).toBe(a.store.text("note-0"));
    expect(await c.store.cursor()).toBeGreaterThan(0);

    a.engine.stop();
    c.engine.stop();
  });

  it("stops with a clear error when the passphrase is wrong", async () => {
    const { token } = await signIn("wrongkey@example.com");
    const a = await device(token);
    a.engine.start();
    await waitFor(synced(a.engine));
    a.store.doc("note").getText("t").insert(0, "secret");
    a.engine.nudge();
    await waitFor(() => a.store.outboxEntries.length === 0);

    const wrong = await deriveKey("wrong passphrase", salt, 1000);
    const b = await device(token, wrong);
    b.engine.start();
    await waitFor(() => b.engine.status().state === "error");
    expect(b.engine.status().error).toMatch(/passphrase/);
    expect(b.store.text("note")).toBe("");
    a.engine.stop();
  });

  it("never moves the cursor past a batch that failed to apply", async () => {
    const { token } = await signIn("failed-batch@example.com");
    const a = await device(token);
    a.engine.start();
    await waitFor(synced(a.engine));
    a.store.doc("note").getText("t").insert(0, "must arrive");
    a.engine.nudge();
    await waitFor(() => a.store.outboxEntries.length === 0);

    // The first attempt to store remote changes fails, as a database error
    // or a failed blob download would. The server has already queued "ready"
    // right behind that batch.
    const b = await device(token);
    const applyRemote = b.store.applyRemote.bind(b.store);
    let failures = 0;
    b.store.applyRemote = async (entries, cursor) => {
      if (failures++ === 0) {
        // Slow, like a database or blob download, so the server's "ready" is
        // already queued behind this batch when it fails.
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error("disk full");
      }
      return applyRemote(entries, cursor);
    };
    b.engine.start();
    await waitFor(() => failures >= 1);
    // Give a queued "ready" time to run (reconnecting takes at least 750 ms).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await b.store.cursor()).toBe(0);

    // After reconnecting it asks again from the stored cursor and catches up.
    await waitFor(() => b.store.text("note") === "must arrive", 15_000);
    expect(failures).toBeGreaterThanOrEqual(2);
    a.engine.stop();
    b.engine.stop();
  });

  it("deleting cloud data empties the server and signs out every device", async () => {
    const { token } = await signIn("wipe@example.com");
    const a = await device(token);
    a.engine.start();
    await waitFor(synced(a.engine));
    a.store.doc("note").getText("t").insert(0, "gone");
    a.engine.nudge();
    await waitFor(() => a.store.outboxEntries.length === 0);
    await put("files", "11111111-2222-3333-4444-555555555555", token, new Uint8Array([1, 2, 3]));

    const deleted = "aaaaaaaa-2222-3333-4444-555555555555";
    await SELF.fetch(`${BASE}/v1/files/${deleted}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect((await env.FILES.list()).objects.some((object) => object.key.endsWith(`/gone/${deleted}`))).toBe(true);
    const wipe = await SELF.fetch(`${BASE}/v1/vault`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect(wipe.status).toBe(200);
    await waitFor(() => a.signedOut.value);
    expect(a.engine.status().state).toBe("error");

    // The old token no longer works, anywhere.
    expect((await SELF.fetch(`${BASE}/v1/key`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    const socket = await SELF.fetch(`${BASE}/v1/sync`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `memnoter.v1, auth.${token}` },
    });
    expect(socket.status).toBe(401);
    const objects = await env.FILES.list();
    expect(objects.objects.filter((object) => object.key.includes("11111111") || object.key.endsWith(`/gone/${deleted}`))).toEqual([]);
  });

  it("syncs a change too large for a log row through R2", async () => {
    const { token } = await signIn("large@example.com");
    const a = await device(token);
    const b = await device(token);
    a.engine.start();
    b.engine.start();
    await waitFor(synced(a.engine));
    await waitFor(synced(b.engine));
    // Random text does not compress: about 2.4 MB of Yjs update.
    const big = Array.from({ length: 1_200_000 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    a.store.doc("huge").getText("t").insert(0, big + big);
    a.engine.nudge();
    await waitFor(() => b.store.text("huge").length === big.length * 2, 20_000);
    expect(a.engine.status().state).toBe("synced");
    a.engine.stop();
    b.engine.stop();
  });

  it("forgets a deleted document on the server", async () => {
    const { token } = await signIn("drop@example.com");
    const a = await device(token);
    a.engine.start();
    await waitFor(synced(a.engine));
    a.store.doc("kept").getText("t").insert(0, "k");
    a.store.doc("deleted").getText("t").insert(0, "d");
    a.engine.nudge();
    await waitFor(() => a.store.outboxEntries.length === 0);
    a.store.drop("deleted");
    a.engine.nudge();
    await waitFor(() => a.store.outboxEntries.length === 0);

    const c = await device(token);
    c.engine.start();
    await waitFor(() => synced(c.engine)() && c.store.text("kept") === "k");
    expect(c.store.docs.has("deleted")).toBe(false);
    a.engine.stop();
    c.engine.stop();
  });
});

function put(kind: string, id: string, token: string, bytes: Uint8Array) {
  return SELF.fetch(`${BASE}/v1/${kind}/${id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Length": String(bytes.length) },
    body: bytes,
  });
}

describe("images", () => {
  it("deletes only the authenticated user's image and is idempotent", async () => {
    const alice = await signIn("delete-a@example.com");
    const bob = await signIn("delete-b@example.com");
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await put("files", id, alice.token, new Uint8Array([1]));
    const remove = (fileId: string, token?: string) => SELF.fetch(`${BASE}/v1/files/${fileId}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    expect((await remove(id)).status).toBe(401);
    expect((await remove("invalid", alice.token)).status).toBe(400);
    expect((await remove(id, bob.token)).status).toBe(200);
    const get = () => SELF.fetch(`${BASE}/v1/files/${id}`, { headers: { Authorization: `Bearer ${alice.token}` } });
    expect((await get()).status).toBe(200);
    expect((await remove(id, alice.token)).status).toBe(200);
    expect((await get()).status).toBe(410);
    expect((await put("files", id, alice.token, new Uint8Array([2]))).status).toBe(410);
    expect((await get()).status).toBe(410);
    expect((await remove(id, alice.token)).status).toBe(200);
  });

  it("stores and serves encrypted images per user", async () => {
    const alice = await signIn("files-a@example.com");
    const bob = await signIn("files-b@example.com");
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect((await put("files", id, alice.token, new Uint8Array([9, 8, 7]))).status).toBe(200);

    const get = (token: string) =>
      SELF.fetch(`${BASE}/v1/files/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const mine = await get(alice.token);
    expect(new Uint8Array(await mine.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    // Another account cannot see it.
    expect((await get(bob.token)).status).toBe(404);

    expect((await put("files", "../escape", alice.token, new Uint8Array([1]))).status).toBe(404);
    expect((await put("files", "not-a-uuid", alice.token, new Uint8Array([1]))).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/files/${id}`)).status).toBe(401);
  });
});

describe("vault protocol", () => {
  it("serves snapshots in place of compacted entries", async () => {
    const { token } = await signIn("compact@example.com");
    const key = await keyPromise;
    const blob = async (doc: string, text: string) => {
      const yDoc = new Y.Doc();
      yDoc.getText("t").insert(0, text);
      return toBase64(await encryptBlob(key, doc, Y.encodeStateAsUpdate(yDoc)));
    };

    const one = await rawSocket(token);
    one.send({ t: "hello", cursor: 0, v: 1 });
    await waitFor(() => one.received.some((m) => m.t === "ready"));
    one.send({
      t: "push",
      id: 1,
      entries: [
        { doc: "x", data: await blob("x", "a") },
        { doc: "y", data: await blob("y", "b") },
        { doc: "x", data: await blob("x", "c") },
      ],
    });
    await waitFor(() => one.received.some((m) => m.t === "ack"));
    const ack = one.received.find((m) => m.t === "ack") as { seq: number };
    const snapshot = await blob("x", "ac");
    one.send({ t: "compact", doc: "x", upTo: ack.seq, data: snapshot });
    // A stale snapshot does not replace a newer one.
    one.send({ t: "compact", doc: "x", upTo: ack.seq - 1, data: await blob("x", "stale") });

    const two = await rawSocket(token);
    two.send({ t: "hello", cursor: 0, v: 1 });
    await waitFor(() => two.received.some((m) => m.t === "ready"));
    const entries = two.received.flatMap((m) => (m.t === "entries" ? m.entries : []));
    expect(entries.map((entry) => entry.doc)).toEqual(["y", "x"]);
    expect(entries[1]).toEqual({ seq: ack.seq, doc: "x", data: snapshot });
    expect(two.received.at(-1)).toEqual({ t: "ready", head: ack.seq });

    // From a cursor past the compaction nothing is resent.
    const three = await rawSocket(token);
    three.send({ t: "hello", cursor: ack.seq, v: 1 });
    await waitFor(() => three.received.some((m) => m.t === "ready"));
    expect(three.received).toEqual([{ t: "ready", head: ack.seq }]);

    // Dropping a document forgets it.
    one.send({ t: "drop", doc: "x" });
    const four = await rawSocket(token);
    four.send({ t: "hello", cursor: 0, v: 1 });
    await waitFor(() => four.received.some((m) => m.t === "ready"));
    expect(four.received.flatMap((m) => (m.t === "entries" ? m.entries : [])).map((e) => e.doc)).toEqual(["y"]);
    for (const socket of [one, two, three, four]) socket.ws.close();
  });

  it("rejects pushes before hello and old protocol versions", async () => {
    const { token } = await signIn("strict@example.com");
    const early = await rawSocket(token);
    early.send({ t: "push", id: 1, entries: [{ doc: "x", data: "AAAA" }] });
    await waitFor(() => early.received.length > 0);
    expect(early.received[0]).toMatchObject({ t: "error" });

    const old = await rawSocket(token);
    old.send({ t: "hello", cursor: 0, v: 0 });
    await waitFor(() => old.received.length > 0);
    expect(old.received[0]).toMatchObject({ t: "error", fatal: true });
  });

  it("answers pings without waking the object", async () => {
    const { token } = await signIn("ping@example.com");
    const response = await SELF.fetch(`${BASE}/v1/sync`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `memnoter.v1, auth.${token}` },
    });
    const ws = response.webSocket!;
    ws.accept();
    const messages: string[] = [];
    ws.addEventListener("message", (event) => messages.push(event.data as string));
    ws.send("ping");
    await waitFor(() => messages.includes("pong"));
    ws.close();
  });
});
