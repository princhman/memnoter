// src/Tiptap.tsx
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";
import * as Y from "yjs";
import Collaboration from "@tiptap/extension-collaboration";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeadingHieararchy } from "@/lib/heading-hierarchy";
import { HeadingActionOverlay } from "@/components/heading-action-overlay";
import { SectionFocus } from "@/lib/section-focus";
import { useActiveEditor } from "@/lib/active-editor-context";
import { FilesContext, SavedImage } from "@/components/saved-image";
import FileHandler from "@tiptap/extension-file-handler";
import {
  applySavedContent,
  loadContent,
  type ContentUpdate,
  type FileType,
  type GetContentResponse,
} from "@/lib/content";
import { InlineMath } from "@/lib/inline-math";
import { Arrows } from "@/lib/arrows";

const COMPACTION_THRESHOLD = 300;
const COMPACTION_IDLE_MS = 3_000;

type TipTapProps = {
  moduleId: string;
};

const Tiptap = ({ moduleId }: TipTapProps) => {
  const yDoc = useMemo(() => new Y.Doc(), [moduleId]);
  const queryClient = useQueryClient();

  const hasAppliedRemoteContent = useRef(false);
  const hasInsertedInitialContent = useRef(false);

  const { isSuccess, data } = useQuery({
    queryKey: ["content", moduleId],
    queryFn: async () => {
      const content = await loadContent(moduleId, yDoc);
      hasAppliedRemoteContent.current = true;
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

  const addUpdateMutation = useMutation({
    mutationKey: ["add-content-update", moduleId],
    mutationFn: async (bytes: number[]) =>
      invoke<ContentUpdate>("add_update", { moduleId, bytes }),

    onSuccess: (update) => {
      queryClient.setQueryData<GetContentResponse>(
        ["content", moduleId],
        (oldContent) => {
          if (!oldContent) return oldContent;

          return {
            state: oldContent.state,
            updates: [...oldContent.updates, update],
            files: oldContent.files,
          };
        },
      );
    },
    onError: (error) => {
      console.error("Failed to save Tiptap update:", error);
    },
  });

  const compactionMutation = useMutation({
    mutationKey: ["compact-content", moduleId],
    mutationFn: async ({
      newState,
      updateId,
    }: {
      newState: number[];
      updateId: number;
    }) => {
      await invoke("save_compaction", { moduleId, newState, updateId });
    },
    onSuccess: (_, { newState, updateId }) => {
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
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));

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

  // applying updates
  useEffect(() => {
    if (!data || hasAppliedRemoteContent.current) return;

    // a cached note has not gone through this editor's query function.
    applySavedContent(yDoc, data);
    hasAppliedRemoteContent.current = true;
  }, [data, yDoc]);

  // attaching updater
  useEffect(() => {
    if (!isSuccess) return;

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "tauri-load") return;
      addUpdateMutation.mutate(Array.from(update));
    };

    yDoc.on("update", handleUpdate);
    return () => {
      yDoc.off("update", handleUpdate);
    };
  }, [isSuccess, yDoc, addUpdateMutation.mutate]);

  async function insertImages(
    currentEditor: Editor,
    files: File[],
    position: number,
  ) {
    if (currentEditor.isDestroyed || !currentEditor.isEditable) return;
    // Map the insertion point through edits made while files are being saved.
    let insertAt = position;
    const mapPosition = ({
      transaction,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      insertAt = transaction.mapping.map(insertAt);
    };
    currentEditor.on("transaction", mapPosition);
    try {
      for (const file of files) {
        const saved = await uploadFileMutation.mutateAsync(file);
        if (currentEditor.isDestroyed) return;
        currentEditor
          .chain()
          .insertContentAt(insertAt, {
            type: "image",
            attrs: { fileId: saved.id, alt: file.name },
          })
          .run();
      }
    } catch (error) {
      console.error("Failed to save image:", error);
    } finally {
      currentEditor.off("transaction", mapPosition);
    }
  }

  const editor = useEditor(
    {
      editable: isSuccess,
      shouldRerenderOnTransaction: false,
      extensions: [
        StarterKit.configure({
          undoRedo: false,
        }),
        Arrows,
        InlineMath,
        HeadingHieararchy,
        SectionFocus,
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
        FileHandler.configure({
          allowedMimeTypes: [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
          ],
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

  useEffect(() => {
    editor?.setEditable(isSuccess, false);
  }, [editor, isSuccess]);

  // if editor is empty
  useEffect(() => {
    if (!editor || !isSuccess || hasInsertedInitialContent.current) return;

    hasInsertedInitialContent.current = true;
    if (editor.isEmpty) {
      editor.commands.setContent("<p>Hello World!</p>");
    }
  }, [editor, isSuccess]);

  // pass editor into the context
  useEffect(() => {
    if (!editor) return;

    setActiveEditor({ moduleId, editor });

    return () => {
      setActiveEditor((current) =>
        current?.editor === editor ? null : current,
      );
    };
  }, [editor, moduleId, setActiveEditor]);

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

      // do not compact while an older update is still being persisted.
      const pendingUpdates = queryClient.isMutating({
        mutationKey: ["add-content-update", moduleId],
      });

      if (pendingUpdates > 0) {
        return;
      }

      const updateId = Math.max(
        ...currentContent.updates.map((update) => update.id),
      );

      const newState = Array.from(Y.encodeStateAsUpdate(yDoc));

      compactionMutation.mutate({
        newState,
        updateId,
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
    </FilesContext.Provider>
  );
};

export default Tiptap;
