import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import * as Y from "yjs";
import { prosemirrorToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import { Slice, Fragment } from "@tiptap/pm/model";
import { Flashcards } from "../src/lib/flashcards.ts";
import { extractCards, blockIdOf } from "../src/lib/cards.ts";
import { normalizedPoint, drawMask, validMasks, maskBounds, withBounds, renewImageIdentity } from "../src/lib/occlusion.ts";
import { moveBox, resizeBox } from "../src/lib/box.ts";

// Real editor transactions exercise persisted node attributes and identity repair.
const ImageNode = Node.create({ name: "image", group: "block", atom: true, addAttributes: () => ({ imageId: { default: null }, fileId: { default: null }, masks: { default: [] }, width: { default: null } }) });
const InlineImage = ImageNode.extend({ name: "inlineImage", group: "inline", inline: true });
const rectangle = { id: "r", shape: "rectangle", x: .1, y: .2, width: .3, height: .4 };
const ellipse = { id: "e", shape: "ellipse", cx: .5, cy: .5, rx: .2, ry: .3 };
const freehand = { id: "f", shape: "freehand", points: [{x:0,y:0},{x:1,y:0},{x:.5,y:1}] };
const image = { type: "image", attrs: { imageId: "source", fileId: "asset", masks: [rectangle, ellipse, freehand] } };
function editorFor(content) {
  const editor = new Editor({ element: null, extensions: [StarterKit, ImageNode, InlineImage, Flashcards], content: { type: "doc", content } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

for (const type of ["image", "inlineImage"]) {
  for (const operation of ["move", "move after copy dragstart", "paste", "copy-drop", "copy-drop after move dragstart"]) {
    test(`${type} ${operation} preserves existing reviews and gives copies fresh identities`, () => {
      const reviewed = { ...image, type, attrs: { ...image.attrs, imageId: "reviewed-image", masks: [{ ...rectangle, id: "reviewed-mask" }] } };
      const block = type === "image" ? reviewed : { type: "paragraph", content: [reviewed] };
      const editor = editorFor([block, { type: "paragraph", content: [{ type: "text", text: "Drop before or after me" }] }]);
      try {
        const moving = operation.startsWith("move");
        const view = editor.view;
        let slice = new Slice(Fragment.from(editor.state.doc.firstChild), 0, 0);
        view.dragging = operation === "paste" ? null : {
          slice, move: operation === "move" || operation === "copy-drop after move dragstart",
        };
        for (const plugin of editor.state.plugins) {
          if (plugin.props.transformPasted) slice = plugin.props.transformPasted(slice, view, false);
        }
        const tr = editor.state.tr;
        if (moving) tr.delete(0, editor.state.doc.firstChild.nodeSize);
        tr.insert(tr.doc.content.size, slice.content).setMeta("uiEvent", operation === "paste" ? "paste" : "drop");
        view.dispatch(tr);
        const cards = extractCards(editor.state.doc);
        assert.equal(cards[0].id, "reviewed-image:o:reviewed-mask");
        assert.equal(cards.length, moving ? 1 : 2);
        if (!moving) {
          assert.notEqual(cards[1].blockId, "reviewed-image");
          assert.notEqual(cards[1].front.targetMaskId, "reviewed-mask");
          assert.equal(cards[1].front.fileId, "asset");
        }
      } finally { editor.destroy(); }
    });
  }
}

test("coordinates align across viewport sizes; reverse drags and all closed shapes validate", () => {
  const p = normalizedPoint(150, 100, {left:50,top:50,width:200,height:100});
  assert.deepEqual(p, {x:.5,y:.5});
  assert.deepEqual(normalizedPoint(250,150,{left:50,top:50,width:400,height:200}), p);
  assert.deepEqual(normalizedPoint(-1,500,{left:0,top:0,width:100,height:100}), {x:0,y:1});
  const drawnRectangle = drawMask("rectangle", [{x:.8,y:.7},{x:.2,y:.1}], "r");
  assert.deepEqual({ ...drawnRectangle, width: undefined }, {id:"r",shape:"rectangle",x:.2,y:.1,width:undefined,height:.6});
  assert.ok(Math.abs(drawnRectangle.width - .6) < 1e-10);
  assert.equal(drawMask("ellipse", [{x:0,y:0},{x:1,y:1}], "e").rx, .5);
  assert.equal(validMasks([rectangle, ellipse, freehand]).length, 3);
  assert.deepEqual(validMasks([{...rectangle,width:2},{...ellipse,rx:0},{...freehand,points:[{x:0,y:0},{x:0,y:0},{x:0,y:0}]}, {...rectangle,x:NaN}]), []);
});

test("one combined snapshot includes inline occlusions and text; resize/reorder preserve identities", () => {
  const editor = editorFor([image, {type:"paragraph",attrs:{cardId:"text"},content:[{type:"text",text:"Q :: A"},{...image,type:"inlineImage",attrs:{...image.attrs,imageId:"inline",masks:[ellipse]}}]}]);
  try {
    const cards = extractCards(editor.state.doc);
    assert.deepEqual(cards.map(c => c.id), ["source:o:r","source:o:e","source:o:f","text","inline:o:e"]);
    assert.equal(blockIdOf(cards[0].id), "source");
    assert.deepEqual(cards[0].back, {...cards[0].front,revealed:true});
    const persisted = prosemirrorToYDoc(editor.state.doc, "default");
    const reopened = new Y.Doc();
    try {
      Y.applyUpdate(reopened, Y.encodeStateAsUpdate(persisted));
      const restored = editor.schema.nodeFromJSON(yDocToProsemirrorJSON(reopened, "default"));
      assert.deepEqual(extractCards(restored), cards);
    } finally { persisted.destroy(); reopened.destroy(); }
    editor.view.dispatch(editor.state.tr.setNodeAttribute(0,"width",200).setNodeAttribute(0,"masks",[freehand,rectangle,ellipse]));
    const next = extractCards(editor.state.doc);
    assert.deepEqual(next.slice(0,3).map(c => c.id), ["source:o:f","source:o:r","source:o:e"]);
    assert.deepEqual(next[1].front.masks[1], rectangle);
    editor.view.dispatch(editor.state.tr.delete(0,1));
    assert.equal(extractCards(editor.state.doc).some(c => c.id === "source:o:r"), false);
    editor.commands.undo();
    assert.ok(extractCards(editor.state.doc).some(c => c.id === "source:o:r"));
  } finally { editor.destroy(); }
});

test("copies renew image and mask identities; cross-note conflict repair leaves other images intact", () => {
  const editor = editorFor([image]);
  try {
    editor.commands.insertContentAt(0,image);
    let cards = extractCards(editor.state.doc);
    assert.equal(cards.length,6);
    assert.deepEqual(cards.slice(3).map(c => c.id), ["source:o:r","source:o:e","source:o:f"]);
    for (const c of cards.slice(0,3)) { assert.notEqual(c.blockId,"source"); assert.ok(!["r","e","f"].includes(c.front.targetMaskId)); }
    const originalCopy = cards.slice(0,3).map(c => c.id);
    assert.equal(editor.commands.renewCardIds(["source"]),true);
    cards = extractCards(editor.state.doc);
    assert.deepEqual(cards.slice(0,3).map(c => c.id),originalCopy);
    assert.ok(cards.slice(3).every(c => c.blockId !== "source"));
    const slice = new Slice(Fragment.from(editor.state.doc.firstChild),0,0);
    let pasted;
    for (const plugin of editor.state.plugins) {
      if (plugin.props.transformPasted) pasted = plugin.props.transformPasted(slice,editor.view,false);
    }
    assert.notEqual(pasted.content.firstChild.attrs.imageId, editor.state.doc.firstChild.attrs.imageId);
    assert.notEqual(pasted.content.firstChild.attrs.masks[0].id, editor.state.doc.firstChild.attrs.masks[0].id);
  } finally { editor.destroy(); }
});

test("masks move and resize through their box, staying inside the image", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  // Moving stops at the image's edge.
  const moved = withBounds(rectangle, moveBox(maskBounds(rectangle), 0.9, -0.5));
  assert.deepEqual([moved.x, moved.y, moved.width, moved.height], [0.7, 0, 0.3, 0.4]);
  // A corner handle drags two edges; the box keeps its minimum size.
  const resized = withBounds(ellipse, resizeBox(maskBounds(ellipse), "se", 0.1, -1, 0.01));
  close(resized.cx, 0.55); close(resized.rx, 0.25); close(resized.ry, 0.005); close(resized.cy - resized.ry, 0.2);
  // A freehand path stretches to fill its new box.
  const stretched = withBounds(freehand, { x: 0.5, y: 0.5, width: 0.5, height: 0.25 });
  assert.deepEqual(stretched.points, [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.75, y: 0.75 }]);
  assert.equal(validMasks([moved, resized, stretched]).length, 3);
});

test("joined masks are one card, kept by their owner, and stay joined when copied", () => {
  const masks = [{ ...rectangle, group: "e" }, ellipse, { ...freehand, group: "e" }, { ...rectangle, id: "solo" }];
  const editor = editorFor([{ ...image, attrs: { ...image.attrs, masks } }]);
  try {
    const cards = extractCards(editor.state.doc);
    assert.deepEqual(cards.map(c => [c.id, c.front.targetMaskIds]), [
      ["source:o:e", ["r", "e", "f"]],
      ["source:o:solo", ["solo"]],
    ]);
    assert.equal(cards[0].front.targetMaskId, "e");
  } finally { editor.destroy(); }

  // Without its owner the group's card passes to its first mask.
  const orphaned = editorFor([{ ...image, attrs: { ...image.attrs, masks: [masks[0], masks[2]] } }]);
  try {
    assert.deepEqual(extractCards(orphaned.state.doc).map(c => c.id), ["source:o:r"]);
  } finally { orphaned.destroy(); }

  let n = 0;
  const copy = renewImageIdentity({ masks }, () => `new${++n}`);
  const byOld = Object.fromEntries(masks.map((m, i) => [m.id, copy.masks[i]]));
  assert.equal(byOld.r.group, byOld.e.id);
  assert.equal(byOld.f.group, byOld.e.id);
  assert.equal(byOld.solo.group, undefined);
});
