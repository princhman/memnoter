import { expect, it } from "vitest";
import contract from "./fixtures/protocol.json";
import { makeBlobRef, readBlobRef, fromBase64, isSupportedProtocol } from "../../shared-ui/src/lib/sync/protocol";
import { deriveKey, exportKey, verifyKeyCheck, decryptBlob } from "../../shared-ui/src/lib/sync/crypto";
it("preserves the shared encrypted protocol contract", async () => {
  expect(readBlobRef(makeBlobRef(contract.blobRef.id))).toBe(contract.blobRef.id);
  for (const id of contract.blobRef.invalid) expect(readBlobRef(new Uint8Array([2, ...new TextEncoder().encode(id)]))).toBeNull();
  const v = contract.keyCheck.vector;
  const key = await deriveKey(v.passphrase, v.salt);
  expect(await exportKey(key)).toBe(v.key);
  expect(await verifyKeyCheck(key, v.check)).toBe(true);
  await expect(decryptBlob(key, "wrong-doc", fromBase64(v.check))).rejects.toThrow();
});

// The server deploys on merge, ahead of the app release, so it must keep
// accepting the released app's protocol (AGENTS.md, Data safety).
it("accepts every protocol version from the oldest supported to the current", () => {
  expect(contract.oldestVersion).toBeLessThanOrEqual(contract.version);
  for (let v = contract.oldestVersion; v <= contract.version; v++) {
    expect(isSupportedProtocol(v)).toBe(true);
    expect(isSupportedProtocol(String(v))).toBe(true);
  }
  for (const v of [contract.oldestVersion - 1, contract.version + 1, 2.5, "2x", "", null, undefined]) {
    expect(isSupportedProtocol(v)).toBe(false);
  }
});

import { SELF } from "cloudflare:test";
import { BASE, signIn } from "./helpers";
it("negotiates the fixture protocol and refuses incompatible hello versions", async () => {
  const { token } = await signIn("protocol-contract@example.com");
  const response = await SELF.fetch(BASE + contract.paths.sync, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${contract.protocol}, ${contract.authPrefix}${token}` },
  });
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(contract.protocol);
  const ws = response.webSocket!;
  ws.accept();
  const closed = new Promise<number>(resolve => ws.addEventListener("close", event => { ws.close(); resolve(event.code); }));
  ws.send(JSON.stringify({ t: contract.clientFrames[0], cursor: 0, v: 1 }));
  expect(await closed).toBe(contract.closePolicy);
});

it("revokes pre-upgrade hibernating sockets before they can publish or receive worksheet data", async () => {
  const { env, runInDurableObject } = await import("cloudflare:test");
  const { token, userId } = await signIn("protocol-hibernating@example.com");
  const response = await SELF.fetch(BASE + contract.paths.sync, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${contract.protocol}, ${contract.authPrefix}${token}` },
  });
  const ws = response.webSocket!;
  ws.accept();
  const messages: unknown[] = [];
  ws.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
  const closed = new Promise<number>(resolve => ws.addEventListener("close", event => { ws.close(); resolve(event.code); }));
  await runInDurableObject(env.VAULT.getByName(userId), async (_instance, state) => {
    // This is exactly the persisted attachment from the v0.1.5 worker.
    state.getWebSockets()[0].serializeAttachment({ ready: true });
  });
  ws.send(JSON.stringify({ t: "push", id: 1, entries: [{ doc: "vault", data: "AA==" }] }));
  expect(await closed).toBe(contract.closePolicy);
  expect(messages).toContainEqual({ t: "error", message: "Please update Memnoter to keep syncing", fatal: true });
  await runInDurableObject(env.VAULT.getByName(userId), async (_instance, state) => {
    expect(state.storage.sql.exec("select * from log").toArray()).toEqual([]);
  });
});
