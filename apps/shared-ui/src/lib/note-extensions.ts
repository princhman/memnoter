import type { Editor } from "@tiptap/core";
import { TabSpacing } from "@/lib/tab-spacing";
import { HeadingNumbering } from "@/lib/heading-numbering";
import { ImageMoveHistory } from "@/lib/image-move-history";
import { NoteHighlight } from "@/lib/highlight";
import { NoteTables } from "@/lib/note-tables";
import StarterKit from "@tiptap/starter-kit";
import type * as Y from "yjs";
import Collaboration from "@tiptap/extension-collaboration";
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
import { IMAGE_TYPES, SlashCommand } from "@/components/slash-menu";
import { LatexSuggest } from "@/components/latex-menu";
import { FindHighlights } from "@/lib/find-highlights";
import { InlineImage, SavedImage } from "@/components/saved-image";
import { InlineMath } from "@/lib/inline-math";
import { MathBlock } from "@/lib/math-block";
import { Arrows } from "@/lib/arrows";
import { MoveLines } from "@/lib/move-lines";
import { TextSelectionHighlight } from "@/lib/text-selection";
import { ItalicCaret } from "@/lib/italic-caret";
import { Flashcards } from "@/lib/flashcards";

type NoteExtensionOptions = {
  document: Y.Doc;
  insertImages?: (editor: Editor, files: File[], position: number) => void;
  onTocUpdate?: (content: TableOfContentData) => void;
  onFirstRender?: () => void;
};

// Every editor of a note's Yjs document must share these: an editor whose
// schema lacks a node or attribute would delete it from the document.
export function noteExtensions({
  document,
  insertImages = () => {},
  onTocUpdate,
  onFirstRender,
}: NoteExtensionOptions) {
  return [
    StarterKit.configure({
      undoRedo: false,
      // Links open in the browser on ⌘-click, through LinkEditor.
      link: { openOnClick: false },
    }),
    NoteHighlight,
    ...NoteTables,
    TabSpacing,
    ImageMoveHistory,
    LinkEditor,
    Arrows,
    MoveLines,
    ItalicCaret,
    TextSelectionHighlight,
    InlineMath,
    MathBlock,
    Flashcards,
    HeadingHieararchy,
    SectionFocus,
    Sections,
    HeadingFold,
    HeadingNumbering,
    SlashCommand.configure({ insertImages }),
    LatexSuggest,
    TableOfContents.configure({
      scrollParent: () =>
        window.document.querySelector<HTMLElement>(".app-scroll-container") ??
        window,
      onUpdate: onTocUpdate,
    }),
    FindHighlights.configure({
      searchDebounceMs: 100,
      injectCSS: false,
    }),
    Collaboration.configure({ document, onFirstRender }),
    SavedImage.configure({
      inline: false,
      allowBase64: false,
      HTMLAttributes: {
        class: "note-image",
      },
    }),
    InlineImage.configure({
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
