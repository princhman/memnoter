import assert from "node:assert/strict";
import { test } from "node:test";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { MarkdownPaste } from "../src/lib/markdown-paste-plugin.ts";
import { HeadingHieararchy } from "../src/lib/heading-hierarchy.ts";

const schema = getSchema([StarterKit]);
const p = value => schema.node("paragraph", null, value ? schema.text(value) : null);
function setup(nodes = [p("")], position = 1, extra = []) {
  const plugin = MarkdownPaste.config.addProseMirrorPlugins()[0];
  let state = EditorState.create({ doc: schema.node("doc", null, nodes), plugins: [history(), plugin, ...extra] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)));
  const view = { get state() { return state; }, dispatch(tr) { state = state.applyTransaction(tr).state; } };
  const paste = (source, options = {}) => {
    let prevented = false;
    const event = { clipboardData: { files: options.files ?? [], items: [], getData: type => type === "text/plain" ? source : options.html ?? "" }, target: options.target ?? null, preventDefault() { prevented = true; } };
    const handled = plugin.props.handleDOMEvents.paste(view, event);
    assert.equal(prevented, handled);
    return handled;
  };
  return { view, paste, plugin };
}

test("Markdown insertion fits mid-paragraph, empty paragraph, list item and heading; one undo restores selection and document", () => {
  for (const [nodes, pos, expected] of [
    [[p("beforeafter")], 7, "beforeboldafter"],
    [[p("")], 1, "bold"],
    [[schema.node("bulletList", null, schema.node("listItem", null, p("item")))], 5, "itboldem"],
    [[schema.node("heading", { level: 2 }, schema.text("Title"))], 3, "Tiboldtle"],
  ]) {
    const { view, paste } = setup(nodes, pos);
    const original = view.state.doc.toJSON();
    assert.equal(paste("**bold**"), true);
    assert.equal(view.state.doc.textContent, expected);
    view.state.doc.check();
    assert.equal(undo(view.state, view.dispatch), true);
    assert.deepEqual(view.state.doc.toJSON(), original);
    assert.equal(view.state.selection.from, pos);
  }
  const { view, paste } = setup([p("leftright")], 5);
  paste("# Heading\n\n- item\n\nlast");
  assert.deepEqual(view.state.doc.content.content.map(n => n.type.name), ["paragraph", "heading", "bulletList", "paragraph"]);
  assert.equal(view.state.doc.textContent, "leftHeadingitemlastright");
  const image = setup([p("leftright")], 5);
  image.paste("![[photo.png]]");
  assert.deepEqual(image.view.state.doc.content.content.map(n => n.textContent), ["left", "[image: photo.png]", "right"]);
});

test("schema without tables or highlight retains readable text", () => {
  const { view, paste } = setup();
  paste("| Name | Value |\n|---|---|\n| ==yellow== | $x_y$ |");
  view.state.doc.check();
  assert.equal(view.state.doc.textContent, "NameValueyellowx_y");
  assert.deepEqual(view.state.doc.content.content.map(n => n.type.name), ["paragraph", "paragraph", "paragraph", "paragraph"]);
});

test("native paste remains responsible for prose, internal HTML, files, raw-text nodes and input controls", () => {
  for (const [value, options] of [
    ["ordinary prose", {}], ["**copied**", { html: '<p data-pm-slice="1 1 []">copied</p>' }],
    ["# picture", { files: [{}] }], ["# find", { target: { closest: () => ({}) } }],
  ]) {
    const { view, paste } = setup();
    const original = view.state.doc.toJSON();
    assert.equal(paste(value, options), false);
    assert.deepEqual(view.state.doc.toJSON(), original);
  }
  const readOnly = setup();
  readOnly.view.editable = false;
  assert.equal(readOnly.paste("# Literal"), false);
  const raw = setup([schema.node("codeBlock", null, schema.text("source"))], 3);
  assert.equal(raw.paste("**literal**"), false);
});

test("HTML falls back to native unless plain text looks like Markdown, and Shift paste stays literal", () => {
  const { view, paste, plugin } = setup();
  assert.equal(paste("Reading view", { html: "<h1>Reading view</h1>" }), false);
  assert.equal(paste("# Source mode", { html: "<pre># Source mode</pre>" }), true);
  assert.equal(view.state.doc.firstChild.type.name, "heading");
  plugin.props.handleDOMEvents.keydown(view, { shiftKey: true, metaKey: true });
  assert.equal(paste("**literal**\n- raw"), true);
  assert.ok(view.state.doc.textContent.includes("**literal**- raw"));
  assert.equal(view.state.doc.rangeHasMark(0, view.state.doc.content.size, schema.marks.bold), false);
});

test("normal transactions retain valid heading levels and let hierarchy correct skipped levels", () => {
  const extra = HeadingHieararchy.config.addProseMirrorPlugins();
  const { view, paste } = setup([p("")], 1, extra);
  paste("# Root\n\n## Child\n\n#### Skipped\n\n## Sibling");
  assert.deepEqual(view.state.doc.content.content.map(n => n.attrs.level), [1, 2, 3, 2]);
  assert.equal(undo(view.state, view.dispatch), true);
  assert.deepEqual(view.state.doc.toJSON(), schema.node("doc", null, p("")).toJSON());
});

test("pasted card syntax receives stable card and cloze IDs through the real append transactions", async () => {
  const { Editor } = await import("@tiptap/core");
  const { Flashcards } = await import("../src/lib/flashcards.ts");
  const { extractCards } = await import("../src/lib/cards.ts");
  const editor = new Editor({ element: null, extensions: [StarterKit, Flashcards, MarkdownPaste], content: { type: "doc", content: [{ type: "paragraph" }] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    const plugin = editor.state.plugins.find(plugin => plugin.props.handleDOMEvents?.paste);
    const source = "# Study\n\nQuestion :: Answer\n\nRemember {{retrieval practice}}.";
    const event = { clipboardData: { files: [], items: [], getData: type => type === "text/plain" ? source : "" }, preventDefault() {} };
    assert.equal(plugin.props.handleDOMEvents.paste(editor.view, event), true);
    const cards = extractCards(editor.state.doc);
    assert.equal(cards.length, 2);
    assert.ok(cards.every(card => typeof card.id === "string" && card.id.length > 10));
    assert.notEqual(cards[0].id, cards[1].id);
    editor.commands.undo();
    assert.deepEqual(extractCards(editor.state.doc), []);
    editor.commands.redo();
    assert.deepEqual(extractCards(editor.state.doc).map(card => card.id), cards.map(card => card.id));
  } finally { editor.destroy(); }
});
