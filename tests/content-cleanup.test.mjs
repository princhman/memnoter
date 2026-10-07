import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import * as Y from "yjs";
import { loadContent } from "../src/lib/content.ts";

globalThis.window = {};
afterEach(() => clearMocks());

function image(id) {
  const node = new Y.XmlElement("image");
  node.setAttribute("fileId", id);
  return node;
}

function files(...ids) {
  return ids.map((id) => ({ id, path: `/files/${id}`, file_type: "image/png" }));
}

test("startup cleanup respects saved updates, duplicate references, and session history", async () => {
  const doc = new Y.Doc();
  const root = doc.getXmlFragment("default");
  const quote = new Y.XmlElement("blockquote");
  quote.insert(0, [image("shared")]);
  root.insert(0, [image("removed"), image("shared"), quote]);
  const state = Array.from(Y.encodeStateAsUpdate(doc));
  const updates = [];
  doc.on("update", (bytes) => updates.push({ id: updates.length + 1, bytes: Array.from(bytes) }));
  doc.transact(() => {
    root.delete(0, 2);
    root.insert(0, [image("new")]);
  });

  let content = { state, updates: [...updates], files: files("removed", "shared", "new", "abandoned") };
  const cleanups = [];
  mockIPC((command, args) => {
    if (command === "get_content") return content;
    assert.equal(command, "cleanup_files");
    cleanups.push(args);
    // The backend may keep an unused file when its disk removal fails.
    return ["removed"];
  });

  const loaded = await loadContent("lifecycle");
  assert.deepEqual(cleanups, [{
    moduleId: "lifecycle",
    fileIds: ["removed", "abandoned"],
    expectedState: state,
    expectedUpdateId: 1,
  }]);
  assert.deepEqual(loaded.files.map((file) => file.id), ["shared", "new", "abandoned"]);

  const history = new Y.UndoManager(root);
  root.delete(0, root.length);
  content = { ...loaded, updates: [...updates] };
  await loadContent("lifecycle");
  assert.equal(cleanups.length, 1, "refetch must not delete images recoverable through undo");
  history.undo();
  assert.match(root.toString(), /fileId="shared"/);
  history.redo();
  await loadContent("lifecycle");
  assert.equal(cleanups.length, 1, "redo must retain the same protection");
  history.destroy();
  doc.destroy();
});

test("incomplete Yjs update chains cannot authorize deletion", async () => {
  const doc = new Y.Doc();
  const root = doc.getXmlFragment("default");
  root.insert(0, [image("earlier")]);
  let later;
  doc.on("update", (bytes) => { later = Array.from(bytes); });
  root.insert(1, [image("later")]);
  mockIPC((command) => {
    assert.equal(command, "get_content", "cleanup must be skipped");
    return { state: [], updates: [{ id: 2, bytes: later }], files: files("earlier", "later") };
  });
  const loaded = await loadContent("incomplete");
  assert.equal(loaded.files.length, 2);
  doc.destroy();
});

test("invalid content and cleanup errors still allow loading without losing file metadata", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const invalid of [true, false]) {
    const content = { state: invalid ? [255] : [], updates: [], files: files("unused") };
    mockIPC((command) => {
      if (command === "get_content") return content;
      assert.equal(invalid, false, "invalid content must not authorize cleanup");
      throw new Error("storage unavailable");
    });
    assert.equal(await loadContent(`failure-${invalid}`), content);
  }
});
