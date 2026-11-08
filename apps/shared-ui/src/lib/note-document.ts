import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call as invoke } from "./backend";
import { applyPendingSaves, saveQueue } from "./saves";
import { restoreView } from "./view-persistence";
import { imageFilesOperation, assertWritable, isWriteAdmitted, MUTATIONS, type WritePermit } from "./write-lifecycle";
import { applySavedContent, contentQueryOptions, acknowledgeCompaction, contentKey, LOAD_ORIGIN, patchContent, type ContentUpdate, loadContent, type FileType, type GetContentResponse } from "./content";

const COMPACTION_THRESHOLD = 300;
const COMPACTION_IDLE_MS = 3_000;

export function useNoteDocument(moduleId: string) {
  const yDoc = useMemo(() => new Y.Doc(), [moduleId]);
  const persistenceTarget = useRef<Y.Doc | null>(null);
  const queryClient = useQueryClient();

  const editorRef = useRef<Editor | null>(null);
  // The editor changes a note as it loads, e.g. giving card text ids. That
  // comes before saving starts, so those changes are kept until it does.
  const hasLoaded = useRef(false);
  const isSaving = useRef(false);
  const loadChanges = useRef<number[][]>([]);

  const { isSuccess, data } = useQuery({
    ...contentQueryOptions(moduleId),
    queryFn: async () => {
      // Taken before reading, so an edit saved meanwhile is in one or the other.
      const pending = saveQueue.pending(moduleId);
      const content = await loadContent(moduleId, yDoc);
      applyPendingSaves(yDoc, pending);
      // Still in the task that filled the editor, so the note is never
      // painted unfolded or at the top first.
      const editor = editorRef.current;
      if (editor && ySyncPluginKey.getState(editor.state)?.doc === yDoc) {
        restoreView(editor, moduleId);
      }
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

  const compactionMutation = useMutation({
    mutationKey: [MUTATIONS.compactContent, moduleId],
    mutationFn: async ({
      newState,
      updateId,
    }: {
      newState: number[];
      updateId: number;
      representedUpdates: ContentUpdate[];
    }) => {
      assertWritable();
      await invoke("save_compaction", { moduleId, newState, updateId });
    },
    onSuccess: (_, { newState, updateId, representedUpdates }) => {
      acknowledgeCompaction(moduleId, newState, representedUpdates);
      patchContent(moduleId, oldContent => ({
        state: newState,
        updates: oldContent.updates.filter(update => update.id > updateId),
        files: oldContent.files,
      }));
    },
  });

  const uploadFileMutation = useMutation({
    mutationKey: [MUTATIONS.uploadFile],
    mutationFn: async ({ file, permit }: { file: File; permit?: WritePermit }) => {
      assertWritable(permit);
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));

      assertWritable(permit);
      return invoke<FileType>("save_file", {
        moduleId,
        bytes,
        mimeType: file.type,
      });
    },
    onSuccess: (update) => {
      patchContent(moduleId, oldContent => ({ ...oldContent, files: [...oldContent.files, update] }));
    },
  });

  // Before the content is applied below, so no change made as it loads is missed.
  useLayoutEffect(() => {
    const keep = (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) hasLoaded.current = true;
      else if (hasLoaded.current && !isSaving.current) {
        loadChanges.current.push(Array.from(update));
      }
    };
    yDoc.on("update", keep);
    return () => yDoc.off("update", keep);
  }, [yDoc]);

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
      if (origin === LOAD_ORIGIN) return;
      saveQueue.enqueue(moduleId, Array.from(update));
    };

    persistenceTarget.current = yDoc;
    isSaving.current = true;
    for (const update of loadChanges.current.splice(0)) {
      saveQueue.enqueue(moduleId, update);
    }
    yDoc.on("update", handleUpdate);
    return () => {
      persistenceTarget.current = null;
      isSaving.current = false;
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
      checkTarget: permit => {
        assertWritable(permit);
        if (persistenceTarget.current !== yDoc || currentEditor.isDestroyed) {
          throw new Error("The original note is closed. Reopen it and add the remaining images, then discard this failed operation.");
        }
      },
      upload: (file, permit) => uploadFileMutation.mutateAsync({ file, permit }),
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
      const currentContent = queryClient.getQueryData<GetContentResponse>(contentKey(moduleId));

      if (
        !currentContent ||
        currentContent.updates.length < COMPACTION_THRESHOLD
      ) {
        return;
      }

      // do not compact while an update is still queued or being persisted;
      // compaction drops saved updates by id, which a queued one lacks yet.
      if (!isWriteAdmitted() || !saveQueue.isIdle(moduleId)) {
        return;
      }

      // isPending is per editor; a compaction started by an earlier editor of
      // this note may still be running, and the later one must not overtake it.
      if (queryClient.isMutating({ mutationKey: [MUTATIONS.compactContent, moduleId] }) > 0) {
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
      saveImage: (file: File, permit?: WritePermit) => uploadFileMutation.mutateAsync({ file, permit }),
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

  return { yDoc, editorRef, isSuccess, filesContext, insertImages };
}
