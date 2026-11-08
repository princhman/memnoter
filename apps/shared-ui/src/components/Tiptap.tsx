import { MermaidView } from "@/lib/editor-schema/mermaid-view";
import { CardNavigationGuard } from "./card-navigation-guard";
import { MathBlockView } from "@/lib/editor-schema/math-block-view";
import { useNoteDocument } from "@/lib/note-document";
import { SavedImage as ImageWithView, InlineImage as InlineImageWithView } from "./saved-image";
import { InlineMathView } from "./inline-math-view";
import { SlashCommand } from "./slash-menu";
import { LatexSuggest } from "./latex-menu";

import { useModules } from "@/lib/modules";
import { traceScroll } from "@/editor-host/scroll";
import { headingNumberingKey } from "@/lib/heading-numbering";
import { watchWriteAdmission } from "@/lib/write-lifecycle";
import { suppressesTextInput } from "@/lib/editor-input";
import { useEditor, EditorContent } from "@tiptap/react";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { redo as yRedo, undo as yUndo } from "@tiptap/y-tiptap";
import { listen } from "../lib/backend.ts";
import { setNativeEditorHistory } from "@/lib/native-history";
import { HeadingActionOverlay } from "@/components/heading-action-overlay";
import { TextBubbleMenu } from "@/components/text-bubble-menu";
import { LinkMenu } from "@/components/link-menu";
import { useActiveEditor } from "@/lib/active-editor-context";
import { usePersistedView } from "@/lib/view-persistence";
import { useSearchIndexing } from "@/lib/search-index";
import { FilesContext } from "@/components/saved-image";
import { noteExtensions } from "@/lib/editor-schema";

import { useCardSchedules, useCardSync } from "@/lib/card-sync";
import { useCardReveal } from "@/lib/card-reveal";
import {
  TableOfContents,
  createTocStore,
} from "@/components/table-of-contents";


type TipTapProps = {
  moduleId: string;
  hostOnly?: boolean;
};

const Tiptap = ({ moduleId, hostOnly = false }: TipTapProps) => {
  const { data: modules } = useModules();
  const numbered = modules?.find(module => module.id === moduleId)?.heading_numbering ?? false;
  const { yDoc, editorRef, isSuccess, filesContext, insertImages } = useNoteDocument(moduleId);
  const tocStore = useMemo(() => createTocStore(), [yDoc]);

  const { setActiveEditor } = useActiveEditor();

  const editor = useEditor(
    {
      editable: isSuccess,
      shouldRerenderOnTransaction: false,
      extensions: noteExtensions({
        document: yDoc,
        ui: {
          savedImage: ImageWithView,
          inlineImage: InlineImageWithView,
          inlineMath: InlineMathView,
          mathBlock: MathBlockView,
          mermaidView: MermaidView,
          menus: [SlashCommand.configure({ insertImages }), LatexSuggest],
        },
        insertImages: (currentEditor, files, position) => {
          void insertImages(currentEditor, files, position);
        },
        onTocUpdate: (content) => tocStore.setState(() => content),
      }),
      editorProps: {
        handleScrollToSelection: (view) => {
          if (hostOnly) { traceScroll("prosemirror.scrollIntoView.suppressed"); return true; }
          if (!view.state.selection.empty) return false;
          const container = view.dom.closest<HTMLElement>(".app-scroll-container");
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
          ...(hostOnly ? {
            "data-native-editor": "true",
            ...(suppressesTextInput(selection)
              ? { inputmode: "none" } : {}),
          } : {}),
          class: "tiptap",
          autocapitalize: "off",
          // macOS WebKit also applies capitalisation through text correction.
          autocorrect: "off",
        }),
      },
      // ai-suggested change to prevent double enter lag
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

  useLayoutEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr.setMeta(headingNumberingKey, numbered));
  }, [editor, numbered]);

  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useLayoutEffect(() => watchWriteAdmission(blocked => {
    if (editor && !editor.isDestroyed) editor.setEditable(isSuccess && !blocked, false);
  }), [editor, isSuccess]);

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    // Serialize transitions, including unmount, so a delayed focus command
    // cannot replace native text-field history after a newer blur.
    let ready = false;
    let disposed = false;
    const update = () => {
      if (ready) setNativeEditorHistory(document.activeElement === dom);
    };
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    const unlisten = listen<string>("menu", ({ payload }) => {
      if (disposed || !editor.isEditable || document.activeElement !== dom) return;
      if (payload === "editor-undo") yUndo(editor.state);
      if (payload === "editor-redo") yRedo(editor.state);
    }).then((stop) => {
      ready = true;
      if (!disposed) update();
      return stop;
    });
    void unlisten.catch(console.error);
    return () => {
      disposed = true;
      ready = false;
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      setNativeEditorHistory(false);
      void unlisten.then((stop) => stop()).catch(console.error);
    };
  }, [editor]);

  usePersistedView(editor, moduleId, isSuccess);
  useSearchIndexing(editor, moduleId, isSuccess);

  useCardSync(editor, moduleId, isSuccess);
  useCardSchedules(editor, moduleId, isSuccess);
  useCardReveal(editor, moduleId, isSuccess);

  // pass editor into the context
  useEffect(() => {
    if (!editor) return;

    setActiveEditor({ moduleId, editor, isReady: isSuccess });

    return () => {
      setActiveEditor((current) =>
        current?.editor === editor ? null : current,
      );
    };
  }, [editor, moduleId, isSuccess, setActiveEditor]);

  return (
    <FilesContext.Provider value={filesContext}>
      {!hostOnly && <CardNavigationGuard editor={editor} ready={isSuccess} />}
      {hostOnly ? <>
        <EditorContent editor={editor} />
        <TableOfContents editor={editor} store={tocStore} numbered={numbered} />
      </> : <>
      <HeadingActionOverlay editor={editor}>
        <EditorContent editor={editor} />
      </HeadingActionOverlay>
      <TextBubbleMenu editor={editor} />
      <LinkMenu editor={editor} />
      <TableOfContents editor={editor} store={tocStore} numbered={numbered} />
      </>}
    </FilesContext.Provider>
  );
};

export default Tiptap;
