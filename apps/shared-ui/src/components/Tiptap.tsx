import { MentionView, MentionSuggest, MentionNavigation, MentionedIn } from "./mentions";
import { MermaidView } from "@/lib/editor-schema/mermaid-view";
import { useEditorHost } from "@/lib/editor-host-context";
import { CardNavigationGuard } from "./card-navigation-guard";
import { MathBlockView } from "@/lib/editor-schema/math-block-view";
import { useNoteDocument } from "@/lib/note-document";
import { PdfTextQuote } from "./pdf-text-quote";
import { SavedImage as ImageWithView, InlineImage as InlineImageWithView } from "./saved-image";
import { InlineMathView } from "./inline-math-view";
import { SlashCommand } from "./slash-menu";
import { LatexSuggest } from "./latex-menu";

import { useModules } from "@/lib/modules";
import { traceScroll } from "@/editor-host/scroll";
import { headingNumberingKey } from "@/lib/heading-numbering";
import { watchWriteAdmission } from "@/lib/write-lifecycle";
import { suppressesTextInput } from "@/lib/editor-input";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { capabilities } from "@/lib/backend";
import { openMacDrawing } from "@/lib/mac-drawing";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { redo as yRedo, undo as yUndo } from "@tiptap/y-tiptap";
import { useNativeHistory } from "@/lib/native-history";
import { HeadingActionOverlay } from "@/components/heading-action-overlay";
import { TextBubbleMenu } from "@/components/text-bubble-menu";
import { LinkMenu } from "@/components/link-menu";
import { useActiveEditor } from "@/lib/active-editor-context";
import { usePersistedView } from "@/lib/view-persistence";
import { useSearchIndexing } from "@/lib/search-index";
import { FilesContext } from "@/components/saved-image";
import { isSchemaReadOnly } from "@/lib/guarded-collaboration";
import { NEWER_VERSION_MESSAGE } from "@/lib/schema-compatibility";
import { noteExtensions } from "@/lib/editor-schema";

import { useCardSchedules, useCardSync } from "@/lib/card-sync";
import { useCardReveal } from "@/lib/card-reveal";
import {
  TableOfContents,
  createTocStore,
} from "@/components/table-of-contents";


type TipTapProps = {
  moduleId: string;
};

const Tiptap = ({ moduleId }: TipTapProps) => {
  const host = useEditorHost();
  const element = useRef<HTMLDivElement>(null);
  const { data: modules } = useModules();
  const numbered = modules?.find(module => module.id === moduleId)?.heading_numbering ?? false;
  const { yDoc, editorRef, isSuccess, filesContext, insertImages, insertQuote, insertTextQuote } = useNoteDocument(moduleId);
  const tocStore = useMemo(() => createTocStore(), [yDoc]);

  const { setActiveEditor } = useActiveEditor();
  const [drawingError, setDrawingError] = useState<string | null>(null);
  const launchDrawing = useCallback(async (current: Editor, target?: { imageId: string; sourceId: string | null }) => {
    try { await openMacDrawing(current, moduleId, target); }
    catch (error) { setDrawingError(error instanceof Error ? error.message : String(error)); }
  }, [moduleId]);

  const editor = useEditor(
    {
      editable: isSuccess,
      shouldRerenderOnTransaction: false,
      extensions: noteExtensions({
        document: yDoc,
        scrollContainer: () => element.current ? host.scrollContainer(element.current) : null,
        ui: {
          ...(!host.isNative ? { mention: MentionView } : {}),
          pdfTextQuote: PdfTextQuote,
          savedImage: ImageWithView,
          inlineImage: InlineImageWithView,
          inlineMath: InlineMathView,
          mathBlock: MathBlockView,
          mermaidView: MermaidView,
          menus: [...(!host.isNative ? [MentionSuggest] : []), SlashCommand.configure({ insertImages, insertDrawing: current => { void launchDrawing(current); } }), LatexSuggest],
        },
        insertImages: (currentEditor, files, position) => {
          void insertImages(currentEditor, files, position);
        },
        onTocUpdate: (content) => tocStore.setState(() => content),
      }),
      editorProps: {
        handleScrollToSelection: (view) => {
          if (host.isNative) { traceScroll("prosemirror.scrollIntoView.suppressed"); return true; }
          if (!view.state.selection.empty) return false;
          const container = host.scrollContainer(view.dom);
          if (!container) return false;

          const caret = view.coordsAtPos(view.state.selection.head);
          const bounds = container.getBoundingClientRect();
          const top = bounds.top + container.clientTop;
          const left = bounds.left + container.clientLeft;
          // Skip ProseMirror's ancestor-scrolling routine when the caret is
          // already visible. Keep its normal reveal behavior outside the viewport.
          return (
            caret.top >= top &&
            caret.bottom <= top + container.clientHeight &&
            caret.left >= left &&
            caret.right <= left + container.clientWidth
          );
        },
        // Apply before NodeView focus calls; only text carets request a keyboard.
        attributes: ({ selection }) => ({
          ...(host.isNative ? {
            ...(suppressesTextInput(selection)
              ? { inputmode: "none" } : {}),
          } : {}),
          class: "tiptap",
          autocapitalize: "off",
          // macOS WebKit also applies capitalisation through text correction.
          autocorrect: "off",
        }),
      },
      onTransaction: ({ editor, transaction }) => {
        const before = editor.state.selection.$from.nodeBefore;
        if (
          !transaction.docChanged ||
          !editor.state.selection.empty ||
          // WebKit can also leave the caret behind after inserted tabs.
          !(before?.type.name === "hardBreak" || before?.text?.endsWith("\t")) ||
          editor.view.composing ||
          !editor.view.hasFocus()
        ) {
          return;
        }

        const selection = editor.view.dom.ownerDocument.getSelection();
        if (!selection?.isCollapsed || selection.rangeCount !== 1) return;

        const range = selection.getRangeAt(0);
        if (!editor.view.dom.contains(range.startContainer)) return;

        // WebKit can draw the caret at its old position after a hard break.
        // Reapply the already-updated DOM selection without changing content.
        // https://github.com/ProseMirror/prosemirror/issues/1092
        const restoredRange = range.cloneRange();
        selection.removeAllRanges();
        selection.addRange(restoredRange);
      },
    },
    [yDoc],
  );

  const newerVersion = useEditorState({ editor, selector: ({ editor }) => isSchemaReadOnly(editor) }) ?? false;

  useLayoutEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr.setMeta(headingNumberingKey, numbered));
  }, [editor, numbered]);

  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useLayoutEffect(() => watchWriteAdmission(blocked => {
    if (editor && !editor.isDestroyed) editor.setEditable(isSuccess && !blocked, false);
  }), [editor, isSuccess]);

  useNativeHistory({
    enabled: () => !!editor?.isEditable && document.activeElement === editor.view.dom,
    undo: () => editor && yUndo(editor.state),
    redo: () => editor && yRedo(editor.state),
  }, editor);

  usePersistedView(editor, moduleId, isSuccess);
  useSearchIndexing(editor, moduleId, isSuccess && !newerVersion);

  useCardSync(editor, moduleId, isSuccess && !newerVersion);
  useCardSchedules(editor, moduleId, isSuccess);
  useCardReveal(editor, moduleId, isSuccess);

  // pass editor into the context
  useEffect(() => {
    if (!editor) return;

    setActiveEditor({ moduleId, editor, isReady: isSuccess, insertQuote, insertTextQuote });

    return () => {
      setActiveEditor((current) =>
        current?.editor === editor ? null : current,
      );
    };
  }, [editor, moduleId, isSuccess, setActiveEditor, insertQuote, insertTextQuote]);

  const drawingFilesContext = useMemo(() => ({ ...filesContext, ...(capabilities.macDrawing && editor ? {
    editDrawing: (imageId: string, sourceId: string | null) => { void launchDrawing(editor, { imageId, sourceId }); },
  } : {}) }), [filesContext, editor, launchDrawing]);

  return (
    <FilesContext.Provider value={drawingFilesContext}>
      <div ref={element} className="contents">
      <Dialog open={drawingError !== null} onOpenChange={open => { if (!open) setDrawingError(null); }}>
        <DialogContent><DialogTitle>Drawing</DialogTitle><p>{drawingError}</p></DialogContent>
      </Dialog>
      {!host.isNative && <><CardNavigationGuard editor={editor} ready={isSuccess} /><MentionNavigation editor={editor} moduleId={moduleId} ready={isSuccess} /></>}
      {newerVersion && <div role="status" className="sticky top-0 z-10 bg-background p-3 text-sm">{NEWER_VERSION_MESSAGE}</div>}
      <div hidden={newerVersion}>
      {host.isNative ? <>
        <EditorContent editor={editor} />
      </> : <>
      <MentionedIn target={{ kind: "module", id: moduleId, nodeId: null, locator: null }} />
      <HeadingActionOverlay editor={editor} moduleId={moduleId}>
        <EditorContent editor={editor} />
      </HeadingActionOverlay>
      <TextBubbleMenu editor={editor} />
      <LinkMenu editor={editor} />
      <TableOfContents editor={editor} store={tocStore} numbered={numbered} />
      </>}
      </div>
      </div>
    </FilesContext.Provider>
  );
};

export default Tiptap;
