// src/Tiptap.tsx
import {
  useEditor,
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import * as Y from "yjs";
import Collaboration from "@tiptap/extension-collaboration";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeadingHieararchy } from "@/lib/heading-hierarchy";
import { HeadingActionOverlay } from "@/components/heading-action-overlay";
import { SectionFocus } from "@/lib/section-focus";
import { useActiveEditor } from "@/lib/active-editor-context";
import Image from "@tiptap/extension-image";
import FileHandler from "@tiptap/extension-file-handler";

const COMPACTION_THRESHOLD = 300;
const COMPACTION_IDLE_MS = 3_000;

type ContentUpdate = {
  id: number;
  bytes: number[];
};

type FileType = {
  id: string;
  path: string;
  file_type: string;
};

const FilesContext = createContext<ReadonlyMap<string, FileType>>(new Map());

function SavedImageView({ node }: NodeViewProps) {
  const filesById = useContext(FilesContext);
  const file = filesById.get(node.attrs.fileId);
  const src = file ? convertFileSrc(file.path) : node.attrs.src;

  return (
    <NodeViewWrapper contentEditable={false}>
      {src ? (
        <img
          src={src}
          alt={node.attrs.alt ?? ""}
          title={node.attrs.title ?? undefined}
          className="note-image"
        />
      ) : (
        <span>Image unavailable</span>
      )}
    </NodeViewWrapper>
  );
}

const SavedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: {
        default: null,
        rendered: false,
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(SavedImageView);
  },
});

type GetContentResponse = {
  state: number[];
  updates: ContentUpdate[];
  files: FileType[];
};

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
      return await invoke<GetContentResponse>("get_content", { moduleId });
    },
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

    if (data.state.length > 0) {
      Y.applyUpdate(yDoc, new Uint8Array(data.state), "tauri-load");
    }

    for (const update of data.updates) {
      Y.applyUpdate(yDoc, new Uint8Array(update.bytes), "tauri-load");
    }

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
  }, [isSuccess, yDoc, addUpdateMutation]);

  const editor = useEditor(
    {
      shouldRerenderOnTransaction: false,
      extensions: [
        StarterKit.configure({
          undoRedo: false,
        }),
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
          allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          onPaste: async (currentEditor, files) => {
            for (const file of files) {
              try {
                const fileResult = await uploadFileMutation.mutateAsync(file);

                if (currentEditor.isDestroyed) return;

                currentEditor
                  .chain()
                  .insertContentAt(currentEditor.state.selection.anchor, {
                    type: "image",
                    attrs: {
                      fileId: fileResult.id,
                    },
                  })
                  .focus()
                  .run();
              } catch (error) {
                console.error("Failed to save image: ", error);
              }
            }
          },
        }),
      ],
      editorProps: {
        attributes: {
          class: "tiptap",
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

  return (
    <FilesContext.Provider value={filesById}>
      <HeadingActionOverlay editor={editor}>
        <EditorContent editor={editor} />
      </HeadingActionOverlay>
    </FilesContext.Provider>
  );
};

export default Tiptap;
