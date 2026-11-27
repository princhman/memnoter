import { useEffect, useMemo, useRef } from "react";
import { queryClient } from "./query-client";
import { useQueries } from "@tanstack/react-query";
import { useEditorState } from "@tiptap/react";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import { useModules } from "./modules";
import { useActiveEditor } from "./active-editor-context";
import { loadStoredNote } from "./note-index";
import { extractMentions } from "./mention-index";

const EMPTY_MODULES: NonNullable<ReturnType<typeof useModules>["data"]> = [];

// Rebuilt from authoritative Yjs content. No backlink writes or migrations.
export function useMentionNotes() {
  const { data: modules = EMPTY_MODULES } = useModules();
  const { activeEditor } = useActiveEditor();
  const live = useEditorState({ editor: activeEditor?.editor ?? null, selector: ({ editor }) => editor?.state.doc, equalityFn: Object.is });
  const liveNote = useMemo(() => live ? extractMentions(live.toJSON()) : null, [live]);
  // On leaving a note, keep its last live mentions as the stored result, so
  // the next note's opening never competes with re-reading this one from disk.
  const leaving = useRef<{ id: string; note: ReturnType<typeof extractMentions> } | null>(null);
  useEffect(() => {
    const previous = leaving.current;
    if (previous && previous.id !== activeEditor?.moduleId) queryClient.setQueryData(["mention-note", previous.id], previous.note);
    leaving.current = activeEditor && liveNote ? { id: activeEditor.moduleId, note: liveNote } : null;
  }, [activeEditor?.moduleId, liveNote]);
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      const [kind, id] = event.query.queryKey;
      if (kind !== "content" || typeof id !== "string" || event.type !== "updated" || event.action.type !== "success") return;
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => { timers.delete(id); void queryClient.invalidateQueries({ queryKey: ["mention-note", id] }); }, 200));
    });
    return () => { unsubscribe(); timers.forEach(clearTimeout); };
  }, []);
  const queries = useQueries({ queries: modules.map(module => ({
    queryKey: ["mention-note", module.id],
    queryFn: async () => {
      const doc = await loadStoredNote(module.id);
      try { return extractMentions(yDocToProsemirrorJSON(doc, "default")); }
      finally { doc.destroy(); }
    },
    staleTime: Infinity,
    // The open note's mentions come from the live editor below. Reading it from
    // disk too repeats the whole note load right as it opens; once another note
    // is active, the invalidated (stale) query refetches on being enabled.
    enabled: activeEditor?.moduleId !== module.id,
  })) });
  return { modules, notes: modules.map((module, index) => ({ ...module, note: activeEditor?.moduleId === module.id && liveNote ? liveNote : queries[index].data ?? { headings: [], images: [], mentions: [] } })), loading: queries.some((query, index) => query.isPending && !(activeEditor?.moduleId === modules[index].id && liveNote)), error: queries.find(query => query.error)?.error };
}
