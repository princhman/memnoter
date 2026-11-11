import "@/App.css";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { noteExtensions } from "@/lib/editor-schema";
import * as Y from "yjs";
import { InlineMathView } from "@/components/inline-math-view";
import { MathBlockView } from "@/lib/editor-schema/math-block-view";
import { CardFace } from "@/components/card-face";
import { LatexSuggest } from "@/components/latex-menu";

const editor = new Editor({
  extensions: noteExtensions({ document: new Y.Doc(), ui: { inlineMath: InlineMathView, mathBlock: MathBlockView, menus: [LatexSuggest] } }),
});
createRoot(document.getElementById("editor")!).render(<>
  <EditorContent editor={editor} />
  <div id="card-math"><CardFace kind="basic" revealed
    front={[{ type: "math", tex: "a^qbc" }]}
    back={[{ type: "math", tex: "a_qbc" }]} /></div>
</>);
Object.assign(window, { editor });
