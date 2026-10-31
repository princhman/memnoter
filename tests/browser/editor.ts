// An editor with the real caret-related extensions and styles, driven by
// tests/math-caret.test.mjs through a real browser engine.
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { InlineMath } from "@/lib/inline-math";
import { MathBlock } from "@/lib/math-block";
import { Arrows } from "@/lib/arrows";
import { MoveLines } from "@/lib/move-lines";
import { ItalicCaret } from "@/lib/italic-caret";
import { HeadingHieararchy } from "@/lib/heading-hierarchy";
import { SectionFocus } from "@/lib/section-focus";
import { Sections } from "@/lib/sections";
import { HeadingFold } from "@/lib/heading-fold";
import "@/App.css";
import "katex/dist/katex.min.css";

const editor = new Editor({
  element: document.getElementById("editor")!,
  extensions: [
    StarterKit.configure({ undoRedo: false }),
    Arrows,
    MoveLines,
    ItalicCaret,
    InlineMath,
    MathBlock,
    HeadingHieararchy,
    SectionFocus,
    Sections,
    HeadingFold,
  ],
});

Object.assign(window, { editor });
