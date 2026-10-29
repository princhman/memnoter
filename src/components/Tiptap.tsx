import { imageFilesOperation, watchWriteAdmission } from "@/lib/write-lifecycle";
// src/Tiptap.tsx
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as Y from "yjs";
import Collaboration from "@tiptap/extension-collaboration";
import { redo as yRedo, undo as yUndo } from "@tiptap/y-tiptap";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyPendingSaves, saveQueue } from "@/lib/saves";
import { HeadingHieararchy } from "@/lib/heading-hierarchy";
import { HeadingActionOverlay } from "@/components/heading-action-overlay";
import { TextBubbleMenu } from "@/components/text-bubble-menu";
import { LinkMenu } from "@/components/link-menu";
import { LinkEditor } from "@/lib/link-editor";
import { SectionFocus } from "@/lib/section-focus";
import { Sections } from "@/lib/sections";
import { HeadingFold } from "@/lib/heading-fold";
import { IMAGE_TYPES, SlashCommand } from "@/components/slash-menu";
import { LatexSuggest } from "@/components/latex-menu";
import { useActiveEditor } from "@/lib/active-editor-context";
import { usePersistedView } from "@/lib/view-persistence";
import { useSearchIndexing } from "@/lib/search-index";
import { FindHighlights } from "@/lib/find-highlights";
import { FilesContext, InlineImage, SavedImage } from "@/components/saved-image";
import FileHandler from "@tiptap/extension-file-handler";
import {
  applySavedContent,
  contentQueryOptions,
  acknowledgeCompaction,
  type ContentUpdate,
  loadContent,
  type FileType,
  type GetContentResponse,
} from "@/lib/content";
import { InlineMath } from "@/lib/inline-math";
import { MathBlock } from "@/lib/math-block";
import { Arrows } from "@/lib/arrows";
import { MoveLines } from "@/lib/move-lines";
import { ItalicCaret } from "@/lib/italic-caret";
import { Flashcards } from "@/lib/flashcards";
import { useCardSync } from "@/lib/card-sync";
import { TableOfContents as TocExtension } from "@tiptap/extension-table-of-contents";
import {
  TableOfContents,
  createTocStore,
} from "@/components/table-of-contents";

let nativeHistoryUpdates = Promise.resolve();
function setNativeEditorHistory(editorFocused: boolean) {
  nativeHistoryUpdates = nativeHistoryUpdates
    .then(() => invoke<void>("set_editor_history", { editorFocused }))
    .catch((error) => {
      if ("__TAURI_INTERNALS__" in window) {
        console.error("Failed to route native history", error);
      }
    });
}

const COMPACTION_THRESHOLD = 300;
const COMPACTION_IDLE_MS = 3_000;

type TipTapProps = {
  moduleId: string;
};

const Tiptap = ({ moduleId }: TipTapProps) => {
  const yDoc = useMemo(() => new Y.Doc(), [moduleId]);
  const persistenceTarget = useRef<Y.Doc | null>(null);
  const queryClient = useQueryClient();
  // TOC updates on scroll; a store keeps those from re-rendering the editor.
  const tocStore = useMemo(() => createTocStore(), [yDoc]);

  const hasInsertedInitialContent = useRef(false);

  const { isSuccess, data } = useQuery({
    ...contentQueryOptions(moduleId),
    queryFn: async () => {
      // Taken before reading, so an edit saved meanwhile is in one or the other.
      const pending = saveQueue.pending(moduleId);
      const content = await loadContent(moduleId, yDoc);
      applyPendingSaves(yDoc, pending);
      return content;
    },
    // local mutations keep this cache current; focus/remount needs no disk read.
    staleTime: Infinity,
  });

  const filesById = useMemo(() => {
    const map = new Map<string, FileType>();

    for (const file of data?.files ?? []) {
      map.set(file.id, file);
    }

    return map;
  }, [data?.files]);

  const { setActiveEditor } = useActiveEditor();

  const compactionMutation = useMutation({
    mutationKey: ["compact-content", moduleId],
    mutationFn: async ({
      newState,
      updateId,
    }: {
      newState: number[];
      updateId: number;
      representedUpdates: ContentUpdate[];
    }) => {
      if (saveQueue.isSuspended()) throw new Error("Compaction writes are suspended.");
      await invoke("save_compaction", { moduleId, newState, updateId });
    },
    onSuccess: (_, { newState, updateId, representedUpdates }) => {
      acknowledgeCompaction(moduleId, newState, representedUpdates);
      queryClient.setQueryData<GetContentResponse>(
        ["content", moduleId],
        (oldContent) => {
          if (!oldContent) return oldContent;

          return {
            state: newState,
            updates: oldContent.updates.filter(
              (update) => update.id > updateId,
            ),
            files: oldContent.files,
          };
        },
      );
    },
  });

  const uploadFileMutation = useMutation({
    mutationKey: ["upload-file"],
    mutationFn: async (file: File) => {
      if (saveQueue.isSuspended()) throw new Error("Image writes are suspended.");
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));

      if (saveQueue.isSuspended()) throw new Error("Image writes are suspended.");
      return invoke<FileType>("save_file", {
        moduleId,
        bytes,
        mimeType: file.type,
      });
    },
    onSuccess: (update) => {
      queryClient.setQueryData<GetContentResponse>(
        ["content", moduleId],
        (oldContent) => {
          if (!oldContent) return oldContent;

          return {
            state: oldContent.state,
            updates: oldContent.updates,
            files: [...oldContent.files, update],
          };
        },
      );
    },
  });

  // applying updates; before paint, so a switched-to note never shows empty
  useLayoutEffect(() => {
    if (!data) return;

    // Publication reconciles save receipts, including reads that finished late.
    // Apply that reconciled data even if the raw read already seeded this doc.
    applySavedContent(yDoc, data);
    applyPendingSaves(yDoc, saveQueue.pending(moduleId));
  }, [data, moduleId, yDoc]);

  // attaching updater
  useEffect(() => {
    if (!isSuccess) return;

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "tauri-load") return;
      saveQueue.enqueue(moduleId, Array.from(update));
    };

    persistenceTarget.current = yDoc;
    yDoc.on("update", handleUpdate);
    return () => {
      persistenceTarget.current = null;
      yDoc.off("update", handleUpdate);
      // Leaving the note: retry any failed saves now rather than after backoff.
      saveQueue.retryNow();
    };
  }, [isSuccess, moduleId, yDoc]);

  async function insertImages(
    currentEditor: Editor,
    files: File[],
    position: number,
  ) {
    if (currentEditor.isDestroyed || !currentEditor.isEditable) return;
    // Keep mapped position and per-file receipts across retries. The original
    // editor is the target; navigation never redirects these files to a new note.
    let insertAt = position;
    const mapPosition = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      insertAt = transaction.mapping.map(insertAt);
    };
    currentEditor.on("transaction", mapPosition);
    return imageFilesOperation(files, {
      checkTarget: () => {
        if (persistenceTarget.current !== yDoc || currentEditor.isDestroyed || saveQueue.isSuspended()) {
          throw new Error("The original note is closed. Reopen it and add the remaining images, then discard this failed operation.");
        }
      },
      upload: file => uploadFileMutation.mutateAsync(file),
      insert: (saved, file) => {
        // Owned retries use programmatic commands while user admission is closed.
        const inserted = currentEditor.chain().insertContentAt(insertAt, {
          type: "image", attrs: { fileId: saved.id, alt: file.name },
        }).run();
        if (!inserted) throw new Error("Could not insert the uploaded image.");
      },
      dispose: () => currentEditor.off("transaction", mapPosition),
    })
      .catch(error => console.error("Failed to insert image:", error));
  }

  const editor = useEditor(
    {
      editable: isSuccess,
      shouldRerenderOnTransaction: false,
      extensions: [
        StarterKit.configure({
          undoRedo: false,
          // Links open in the browser on ⌘-click, through LinkEditor.
          link: { openOnClick: false },
        }),
        LinkEditor,
        Arrows,
        MoveLines,
        ItalicCaret,
        InlineMath,
        MathBlock,
        Flashcards,
        HeadingHieararchy,
        SectionFocus,
        Sections,
        HeadingFold,
        SlashCommand.configure({
          insertImages: (currentEditor, files, position) => {
            void insertImages(currentEditor, files, position);
          },
        }),
        LatexSuggest,
        TocExtension.configure({
          scrollParent: () =>
            document.querySelector<HTMLElement>(".app-scroll-container") ??
            window,
          onUpdate: (content) => tocStore.setState(() => content),
        }),
        FindHighlights.configure({
          searchDebounceMs: 100,
          injectCSS: false,
        }),
        Collaboration.configure({
          document: yDoc,
        }),
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
            void insertImages(
              currentEditor,
              files,
              currentEditor.state.selection.anchor,
            );
          },
          onDrop: (currentEditor, files, position) => {
            void insertImages(currentEditor, files, position);
          },
        }),
      ],
      editorProps: {
        handleScrollToSelection: (view) => {
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
        attributes: {
          class: "tiptap",
          autocapitalize: "off",
          // macOS WebKit also applies capitalisation through text correction.
          autocorrect: "off",
        },
      },
      // ai-suggested change to prevent double enter lag
      onTransaction: ({ editor, transaction }) => {
        if (
          !transaction.docChanged ||
          !editor.state.selection.empty ||
          editor.state.selection.$from.nodeBefore?.type.name !== "hardBreak" ||
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

  // if editor is empty
  useEffect(() => {
    if (!editor || !isSuccess || !editor.isEditable || hasInsertedInitialContent.current) return;

    hasInsertedInitialContent.current = true;
    if (editor.isEmpty) {
      editor.commands.setContent("<p>Hello World!</p>");
    }
  }, [editor, isSuccess]);

  // restore where the reader left off; runs after the empty-note content above
  usePersistedView(editor, moduleId, isSuccess);
  useSearchIndexing(editor, moduleId, isSuccess);

  useCardSync(editor, moduleId, isSuccess);

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

  // compaction listener
  useEffect(() => {
    if (!data || data.updates.length < COMPACTION_THRESHOLD) {
      return;
    }

    if (compactionMutation.isPending) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      // read the latest cache rather than using possibly stale effect data.
      const currentContent = queryClient.getQueryData<GetContentResponse>([
        "content",
        moduleId,
      ]);

      if (
        !currentContent ||
        currentContent.updates.length < COMPACTION_THRESHOLD
      ) {
        return;
      }

      // do not compact while an update is still queued or being persisted;
      // compaction drops saved updates by id, which a queued one lacks yet.
      if (saveQueue.isSuspended() || !saveQueue.isIdle(moduleId)) {
        return;
      }

      // isPending is per editor; a compaction started by an earlier editor of
      // this note may still be running, and the later one must not overtake it.
      if (queryClient.isMutating({ mutationKey: ["compact-content", moduleId] }) > 0) {
        return;
      }

      const updateId = Math.max(
        ...currentContent.updates.map((update) => update.id),
      );

      // Every receipt below the watermark must be represented in this doc.
      applySavedContent(yDoc, currentContent);
      const newState = Array.from(Y.encodeStateAsUpdate(yDoc));

      compactionMutation.mutate({
        newState,
        updateId,
        representedUpdates: currentContent.updates,
      });
    }, COMPACTION_IDLE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    data,
    moduleId,
    yDoc,
    queryClient,
    compactionMutation.isPending,
    compactionMutation.mutate,
  ]);

  // Save acknowledgements must not invalidate every image's context value.
  const filesContext = useMemo(
    () => ({
      files: filesById,
      saveImage: (file: File) => uploadFileMutation.mutateAsync(file),
      readImage: async (fileId: string) => {
        const contents = await invoke<{ bytes: number[]; file_type: string }>(
          "read_file",
          { moduleId, fileId },
        );
        return new Blob([new Uint8Array(contents.bytes)], {
          type: contents.file_type,
        });
      },
    }),
    [filesById, moduleId, uploadFileMutation.mutateAsync],
  );

  return (
    <FilesContext.Provider value={filesContext}>
      <HeadingActionOverlay editor={editor}>
        <EditorContent editor={editor} />
      </HeadingActionOverlay>
      <TextBubbleMenu editor={editor} />
      <LinkMenu editor={editor} />
      <TableOfContents editor={editor} store={tocStore} />
    </FilesContext.Provider>
  );
};

export default Tiptap;
