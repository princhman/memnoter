import type { Schema } from "@tiptap/pm/model";
import * as Y from "yjs";

export const NEWER_VERSION_MESSAGE = "This note was edited with a newer version of Memnoter. Update the app to edit it.";

// Match y-tiptap's encoding for overlapping marks (name plus an 8-char hash).
const markName = (key: string) => key.replace(/--[a-zA-Z0-9+/=]{8}$/, "");
const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function knownAttrs(value: object, declared: object = {}) {
  return Object.keys(value).every(key => owns(declared, key));
}

// Read the live XML, never convert it through ProseMirror: conversion itself
// can delete unknown nodes and marked text. Iterative traversal keeps large,
// deeply nested notes safe without serializing their history or cloning a doc.
export function hasUnknownContent(fragment: Y.XmlFragment, schema: Schema): boolean {
  const pending = fragment.toArray();
  while (pending.length) {
    const node = pending.pop()!;
    if (node instanceof Y.XmlElement) {
      if (!owns(schema.nodes, node.nodeName)) return true;
      if (!knownAttrs(node.getAttributes(), schema.nodes[node.nodeName].spec.attrs)) return true;
      for (const child of node.toArray()) pending.push(child);
    } else if (node instanceof Y.XmlText) {
      if (!knownAttrs(node.getAttributes(), schema.nodes.text.spec.attrs)) return true;
      for (const delta of node.toDelta()) {
        // ProseMirror only understands string inserts in XmlText.
        if (typeof delta.insert !== "string") return true;
        for (const [key, attrs] of Object.entries(delta.attributes ?? {})) {
          const name = markName(key);
          if (!owns(schema.marks, name)) return true;
          if (attrs && typeof attrs === "object" && !knownAttrs(attrs, schema.marks[name].spec.attrs)) return true;
        }
      }
    } else return true;
  }
  return false;
}
