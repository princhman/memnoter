import { useEffect, useMemo } from "react";
import { queryClient } from "./query-client";
import { useQueries } from "@tanstack/react-query";
import { useEditorState } from "@tiptap/react";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import { useModules } from "./modules";
import { useActiveEditor } from "./active-editor-context";
import { loadStoredNote } from "./note-index";
import { extractMentions } from "./mention-index";

// Rebuilt from authoritative Yjs content. No backlink writes or migrations.
export function useMentionNotes() {
  const { data: modules = [] } = useModules();
  const { activeEditor } = useActiveEditor();
  const live = useEditorState({ editor: activeEditor?.editor ?? null, selector: ({ editor }) => editor?.state.doc, equalityFn: Object.is });
  const liveNote = useMemo(() => live ? extractMentions(live.toJSON()) : null, [live]);
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
  })) });
  return { notes: modules.map((module, index) => ({ ...module, note: activeEditor?.moduleId === module.id && liveNote ? liveNote : queries[index].data ?? { headings: [], mentions: [] } })), loading: queries.some(query => query.isPending), error: queries.find(query => query.error)?.error };
}
