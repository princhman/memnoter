import { headingId } from "./outline";
import { MarkdownPaste } from "./markdown-paste-plugin";
import type { Editor, AnyExtension } from "@tiptap/core";
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
import { IMAGE_TYPES, SavedImage, InlineImage } from "./editor-schema/images";
import { FindHighlights } from "@/lib/find-highlights";
import { InlineMath } from "@/lib/inline-math";
import { MathBlock } from "@/lib/math-block";
import { Arrows } from "@/lib/arrows";
import { MoveLines } from "@/lib/move-lines";
import { TextSelectionHighlight } from "@/lib/text-selection";
import { ItalicCaret } from "@/lib/italic-caret";
import { Flashcards } from "@/lib/flashcards";

// Outline layout reads force WebKit to lay out the whole note. Keep saved
// heading IDs synchronous (the upstream plugin), but coalesce visual refreshes.
const tocRefreshes = new WeakMap<Editor, ReturnType<typeof setTimeout>>();
const DeferredTableOfContents = TableOfContents.extend({
  onTransaction({ transaction }) {
    if (!transaction.docChanged || transaction.getMeta("toc")) return;
    // Navigation must use current positions even while visual work is pending.
    this.storage.content = this.storage.content.flatMap(item => {
      const pos = transaction.mapping.map(item.pos);
      const node = this.editor.state.doc.nodeAt(pos);
      if (!node || headingId(node) !== item.id) return [];
      return [{ ...item, pos, node }];
    });
    this.options.onUpdate?.(this.storage.content, false);
    clearTimeout(tocRefreshes.get(this.editor));
    tocRefreshes.set(this.editor, setTimeout(() => {
      tocRefreshes.delete(this.editor);
      if (!this.editor.isDestroyed) this.editor.commands.updateTableOfContents();
    }, 100));
  },
  onDestroy() {
    clearTimeout(tocRefreshes.get(this.editor));
    tocRefreshes.delete(this.editor);
    this.parent?.();
  },
});

type NoteExtensionOptions = {
  document: Y.Doc;
  ui?: { inlineMath?: AnyExtension; mathBlock?: AnyExtension; savedImage?: typeof SavedImage; inlineImage?: typeof InlineImage; menus?: AnyExtension[] };
  insertImages?: (editor: Editor, files: File[], position: number) => void;
  onTocUpdate?: (content: TableOfContentData) => void;
  onFirstRender?: () => void;
};

// Every editor of a note's Yjs document must share these: an editor whose
// schema lacks a node or attribute would delete it from the document.
export function noteExtensions({
  document,
  ui = {},
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
    MarkdownPaste,
    TabSpacing,
    ImageMoveHistory,
    LinkEditor,
    Arrows,
    MoveLines,
    ItalicCaret,
    TextSelectionHighlight,
    ui.inlineMath ?? InlineMath,
    ui.mathBlock ?? MathBlock,
    Flashcards,
    HeadingHieararchy,
    SectionFocus,
    Sections,
    HeadingFold,
    HeadingNumbering,
    ...(ui.menus ?? []),
    DeferredTableOfContents.configure({
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
