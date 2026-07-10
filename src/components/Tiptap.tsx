// src/Tiptap.tsx
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";
import * as Y from "yjs";
import Collaboration from "@tiptap/extension-collaboration";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type GetContentResponse = {
  state: number[];
  updates: number[][];
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

  const addUpdateMutation = useMutation({
    mutationFn: async (bytes: number[]) =>
      invoke("add_update", { moduleId, bytes }),

    onSuccess: (_, bytes) => {
      queryClient.setQueryData<GetContentResponse>(
        ["content", moduleId],
        (oldContent) => {
          if (!oldContent) return oldContent;

          return {
            state: oldContent.state,
            updates: [...oldContent.updates, bytes],
          };
        },
      );
    },
    onError: (error) => {
      console.error("Failed to save Tiptap update:", error);
    },
  });

  // applying updates
  useEffect(() => {
    if (!data || hasAppliedRemoteContent.current) return;

    if (data.state.length > 0) {
      Y.applyUpdate(yDoc, new Uint8Array(data.state), "tauri-load");
    }

    for (const update of data.updates) {
      Y.applyUpdate(yDoc, new Uint8Array(update), "tauri-load");
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
      extensions: [
        StarterKit.configure({
          undoRedo: false,
        }),
        Collaboration.configure({
          document: yDoc,
        }),
      ],
      editorProps: {
        attributes: {
          class: "tiptap",
        },
      },
    },
    [yDoc],
  );

  useEffect(() => {
    if (!editor || !isSuccess || hasInsertedInitialContent.current) return;

    hasInsertedInitialContent.current = true;
    if (editor.isEmpty) {
      editor.commands.setContent("<p>Hello World!</p>");
    }
  }, [editor, isSuccess]);

  return <main className="tiptap-shell">
    <EditorContent editor={editor} />
  </main>;
};

export default Tiptap;
