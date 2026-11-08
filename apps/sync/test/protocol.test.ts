import { expect, it } from "vitest";
import contract from "./fixtures/protocol.json";
import { makeBlobRef, readBlobRef, fromBase64 } from "../../shared-ui/src/lib/sync/protocol";
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
  ws.send(JSON.stringify({ t: contract.clientFrames[0], cursor: 0, v: contract.version + 1 }));
  expect(await closed).toBe(contract.closePolicy);
});
