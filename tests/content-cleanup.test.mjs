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

test("opening a long edit history publishes only the complete document and preserves undo", async () => {
  const source = new Y.Doc();
  const root = source.getXmlFragment("default");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "Saved text");
  paragraph.insert(0, [text]);
  root.insert(0, [paragraph, image("keep")]);
  const state = Array.from(Y.encodeStateAsUpdate(source));
  const updates = [];
  source.on("update", (bytes) => updates.push({ id: updates.length + 1, bytes: Array.from(bytes) }));
  for (let i = 0; i < 250; i++) text.insert(text.length, ".");
  const content = { state, updates, files: files("keep", "unused") };
  mockIPC((command, args) => {
    if (command === "get_content") return content;
    assert.equal(command, "cleanup_files");
    assert.deepEqual(args.fileIds, ["unused"]);
    assert.equal(args.expectedUpdateId, 250);
    return ["unused"];
  });

  const document = new Y.Doc();
  const restoredRoot = document.getXmlFragment("default");
  const history = new Y.UndoManager(restoredRoot);
  const visibleStates = [];
  restoredRoot.observeDeep((_, transaction) => {
    visibleStates.push({ content: restoredRoot.toString(), origin: transaction.origin });
  });
  try {
    const loaded = await loadContent("batched-opening", document);
    assert.equal(restoredRoot.toString(), root.toString());
    assert.equal(visibleStates.length, 1, "opening must not expose intermediate edits");
    assert.deepEqual(visibleStates, [{ content: root.toString(), origin: "tauri-load" }]);
    assert.deepEqual(loaded.files.map((file) => file.id), ["keep"]);
    assert.deepEqual(loaded.updates, updates, "retain update IDs for later compaction");
    assert.equal(history.undoStack.length, 0, "loading is not an undoable edit");
    restoredRoot.get(0).get(0).insert(0, "New edit ");
    history.undo();
    assert.equal(restoredRoot.toString(), root.toString(), "undo only reverts the new edit");
  } finally {
    history.destroy();
    document.destroy();
    source.destroy();
  }
});

test("startup cleanup respects saved updates, duplicate references, and later loads", async () => {
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

  root.delete(0, root.length);
  content = { ...loaded, updates: [...updates] };
  await loadContent("lifecycle");
  assert.equal(cleanups.length, 1, "refetch must not delete images recoverable through undo");
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
