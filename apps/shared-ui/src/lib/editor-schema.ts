import { MarkdownPaste } from "./markdown-paste-plugin";
import { getSchema, type Editor, type AnyExtension } from "@tiptap/core";
import { CodeSpacing } from "@/lib/code-spacing";
import { TabSpacing } from "@/lib/tab-spacing";
import { HeadingNumbering } from "@/lib/heading-numbering";
import { ImageMoveHistory } from "@/lib/image-move-history";
import { NoteHighlight } from "@/lib/highlight";
import { NoteTables } from "@/lib/note-tables";
import StarterKit from "@tiptap/starter-kit";
import * as Y from "yjs";
import { GuardedCollaboration } from "./guarded-collaboration";
import { hasUnknownContent } from "./schema-compatibility";
import FileHandler from "@tiptap/extension-file-handler";
import {
  TableOfContents,
  type TableOfContentData,
} from "@tiptap/extension-table-of-contents";
import { HeadingHieararchy } from "@/lib/heading-hierarchy";
import { LinkEditor } from "@/lib/link-editor";
import { SectionFocus } from "@/lib/section-focus";
import { Sections } from "@/lib/sections";
import { HeadingFold } from "@/lib/heading-fold";
import { IMAGE_TYPES, SavedImage, InlineImage } from "./editor-schema/images";
import { FindHighlights } from "@/lib/find-highlights";
import { InlineMath } from "@/lib/inline-math";
import { MathBlock } from "@/lib/math-block";
import { Arrows } from "@/lib/arrows";
import { MoveLines } from "@/lib/move-lines";
import { TextSelectionHighlight } from "@/lib/text-selection";
import { ItalicCaret } from "@/lib/italic-caret";
import { PdfTextQuote } from "./editor-schema/pdf-text-quotes";
import { Flashcards } from "@/lib/flashcards";
import { FoldableBlock } from "@/lib/foldable-block";

type NoteExtensionOptions = {
  document: Y.Doc;
  ui?: { pdfTextQuote?: typeof PdfTextQuote; mermaidView?: AnyExtension; inlineMath?: AnyExtension; mathBlock?: AnyExtension; savedImage?: typeof SavedImage; inlineImage?: typeof InlineImage; menus?: AnyExtension[] };
  insertImages?: (editor: Editor, files: File[], position: number) => void;
  scrollContainer?: () => HTMLElement | null;
  onTocUpdate?: (content: TableOfContentData) => void;
  onFirstRender?: () => void;
};

// Every editor of a note's Yjs document must share these: an editor whose
// schema lacks a node or attribute would delete it from the document.
export function noteExtensions({
  document,
  ui = {},
  insertImages = () => {},
  scrollContainer,
  onTocUpdate,
  onFirstRender,
}: NoteExtensionOptions) {
  return [
    StarterKit.configure({
      undoRedo: false,
      // Links open in the browser on ⌘-click, through LinkEditor.
      link: { openOnClick: false },
    }),
    ...(ui.mermaidView ? [ui.mermaidView] : []),
    NoteHighlight,
    ...NoteTables,
    MarkdownPaste,
    TabSpacing,
    CodeSpacing,
    ImageMoveHistory,
    LinkEditor,
    Arrows,
    MoveLines,
    ItalicCaret,
    TextSelectionHighlight,
    ui.inlineMath ?? InlineMath,
    ui.mathBlock ?? MathBlock,
    Flashcards,
    ui.pdfTextQuote ?? PdfTextQuote,
    ...FoldableBlock,
    HeadingHieararchy,
    SectionFocus,
    Sections,
    HeadingFold,
    HeadingNumbering,
    ...(ui.menus ?? []),
    TableOfContents.configure({
      scrollParent: () => scrollContainer?.() ?? window,
      onUpdate: onTocUpdate,
    }),
    FindHighlights.configure({
      searchDebounceMs: 100,
      injectCSS: false,
    }),
    GuardedCollaboration.configure({ document, onFirstRender }),
    (ui.savedImage ?? SavedImage).configure({
      inline: false,
      allowBase64: false,
      HTMLAttributes: {
        class: "note-image",
      },
    }),
    (ui.inlineImage ?? InlineImage).configure({
      allowBase64: false,
      HTMLAttributes: {
        class: "note-image",
      },
    }),
    FileHandler.configure({
      allowedMimeTypes: IMAGE_TYPES,
      consumePasteEvent: true,
      onPaste: (currentEditor, files) => {
        insertImages(currentEditor, files, currentEditor.state.selection.anchor);
      },
      onDrop: (currentEditor, files, position) => {
        insertImages(currentEditor, files, position);
      },
    }),
  ];
}

// Hidden consumers need the same persisted schema without mounting an editor.
let persistedSchema: ReturnType<typeof getSchema> | undefined;
export function isNoteFromNewerVersion(doc: Y.Doc) {
  if (!persistedSchema) {
    const empty = new Y.Doc();
    try { persistedSchema = getSchema(noteExtensions({ document: empty })); }
    finally { empty.destroy(); }
  }
  return hasUnknownContent(doc.getXmlFragment("default"), persistedSchema);
}
