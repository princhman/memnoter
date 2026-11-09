import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { drawingReference } from "../lib/drawing";

function target(editor: Editor, imageId: string) {
  const matches: { node: Node; pos: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (["image", "inlineImage"].includes(node.type.name) && node.attrs.imageId === imageId && drawingReference(node.attrs.drawing)) matches.push({ node, pos });
  });
  if (matches.length !== 1) throw new Error("This drawing was removed or its identity changed. Save a copy to keep your work.");
  return matches[0];
}

export function beginDrawing(editor: Editor, imageId: unknown) {
  if (typeof imageId !== "string" || !imageId) throw new Error("Drawing identity is required");
  let exists = false;
  editor.state.doc.descendants(node => { if (node.attrs.imageId === imageId && drawingReference(node.attrs.drawing)) exists = true; });
  if (exists) return true;
  return editor.commands.insertContentAt(editor.state.selection.to, [
    { type: "image", attrs: { imageId, alt: "Drawing", drawing: { version: 1, sourceId: null, previewId: null } } },
    { type: "paragraph" },
  ]);
}

export function commitDrawing(editor: Editor, args: Record<string, unknown>) {
  const { imageId, sourceId, previewId, expectedSourceId } = args;
  if (typeof imageId !== "string" || typeof sourceId !== "string" || !sourceId || typeof previewId !== "string" || !previewId || !(expectedSourceId === null || typeof expectedSourceId === "string")) throw new Error("Invalid drawing revision");
  const { node, pos } = target(editor, imageId);
  const current = drawingReference(node.attrs.drawing)!;
  if (current.sourceId === sourceId && current.previewId === previewId) return true;
  if (current.sourceId !== expectedSourceId) throw new Error("This drawing changed on another device. Save a copy to keep both versions.");
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs, fileId: previewId, src: null, masks: [],
    drawing: { version: 1, sourceId, previewId },
  }));
  return true;
}

export function discardEmptyDrawing(editor: Editor, imageId: unknown) {
  if (typeof imageId !== "string") throw new Error("Drawing identity is required");
  const { node, pos } = target(editor, imageId);
  if (drawingReference(node.attrs.drawing)?.sourceId !== null) return false;
  editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
  return true;
}
