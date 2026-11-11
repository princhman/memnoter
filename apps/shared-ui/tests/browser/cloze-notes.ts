// Foldable blocks and cloze notes, with their real node view, for
// tests/card-info.test.mjs.
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { noteExtensions } from "@/lib/editor-schema";
import { MathBlockView } from "@/lib/editor-schema/math-block-view";
import "@/App.css";
import "katex/dist/katex.min.css";

const editor = new Editor({
  element: document.getElementById("editor")!,
  // The note's schema, without Yjs, so the content below is the document.
  extensions: noteExtensions({ document: new Y.Doc(), ui: { mathBlock: MathBlockView } }).filter((extension) => extension.name !== "collaboration"),
  content: {
    type: "doc",
    content: [{
      type: "details",
      attrs: { open: true },
      content: [
        { type: "detailsSummary", content: [{ type: "text", text: "Proof" }] },
        { type: "detailsContent", content: [
          { type: "paragraph", content: [{ type: "text", text: "Step {{one}}" }] },
          { type: "mathBlock", content: [{ type: "text", text: "a + b" }] },
        ] },
      ],
    }],
  },
});

Object.assign(window, { editor });
