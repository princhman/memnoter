// An editor with the real caret-related extensions and styles, driven by
// tests/math-caret.test.mjs through a real browser engine.
import { Editor } from "@tiptap/core";
import { InlineMathView as InlineMath } from "@/components/inline-math-view";
import { MathBlockView as MathBlock } from "@/lib/editor-schema/math-block-view";
import { noteExtensions } from "@/lib/editor-schema";
import * as Y from "yjs";
import "@/App.css";
import "katex/dist/katex.min.css";

const editor = new Editor({
  element: document.getElementById("editor")!,
  extensions: noteExtensions({
    document: new Y.Doc(),
    ui: { inlineMath: InlineMath, mathBlock: MathBlock },
  }),
});

Object.assign(window, { editor });
