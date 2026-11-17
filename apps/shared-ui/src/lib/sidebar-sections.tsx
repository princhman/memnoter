import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { createStore, useSelector } from "@tanstack/react-store";
import type { JSONContent } from "@tiptap/core";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { useActiveEditor } from "./active-editor-context";
import { call } from "./backend";
import { applySavedContent, contentQueryOptions, type GetContentResponse } from "./content";
import { applyPendingSaves, saveQueue } from "./saves";
import { outline, UNTITLED_SECTION } from "./outline";
import { sectionFocusKey } from "./section-focus";
import { getFoldedIds, getFoldedRanges } from "./heading-fold";
import { beginHostNavigation, editorHost } from "./editor-host";
import { stopScrollRestore } from "./view-persistence";
import { setModulePage } from "./store";
import { headingNumbers, numberHeadings } from "./heading-numbering";
import { toast } from "sonner";

// id is null only for an empty H1 in a closed note saved before it had one.
type Section = { id: string | null; key: string; title: string; number: string };
const destination = createStore<{ moduleId: string; headingId: string | null; addSection?: boolean } | null>(null);

export function openSidebarSection(moduleId: string, headingId: string | null) {
  setModulePage(moduleId, "notes");
  destination.setState(() => ({ moduleId, headingId }));
}

export function addSidebarSection(moduleId: string) {
  setModulePage(moduleId, "notes");
  destination.setState(() => ({ moduleId, headingId: null, addSection: true }));
}

export function useSidebarSections(moduleId: string, expanded: boolean) {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.moduleId === moduleId && activeEditor.isReady && !activeEditor.editor.isDestroyed ? activeEditor.editor : null;
  // useEditorState retains its last snapshot when its editor becomes null.
  // Read from the current editor directly so closed notes use saved content
  // again, including moves made while a different note is open.
  const subscribe = useCallback((notify: () => void) => {
    if (!editor) return () => {};
    editor.on("transaction", notify);
    return () => { editor.off("transaction", notify); };
  }, [editor]);
  const snapshot = useCallback(() => editor && !editor.isDestroyed ? editor.state : null, [editor]);
  const liveState = useSyncExternalStore(subscribe, snapshot, () => null);
  const live = liveState?.doc ?? null;
  const focusedId = useMemo(() => {
    if (!liveState) return null;
    const pos = sectionFocusKey.getState(liveState);
    // Highlight the parent H1 even when a subsection was focused from Contents.
    const headings = outline(liveState.doc);
    return pos == null ? null : headings.find(item => item.level === 1 && item.pos <= pos && item.end > pos)?.id ?? null;
  }, [liveState]);
  const query = useQuery({
    ...contentQueryOptions(moduleId),
    queryFn: () => call<GetContentResponse>("get_content", { moduleId }),
    enabled: expanded && !editor,
    staleTime: Infinity,
  });
  const sections = useMemo<Section[]>(() => {
    if (live) {
      const numbers = headingNumbers(live);
      // Every numbered H1 is listed, so the sidebar never skips a chapter number.
      return outline(live).filter(item => item.level === 1).map(item => ({ id: item.id, key: item.id ?? `pos-${item.pos}`, title: item.title, number: numbers.get(item.pos) ?? "" }));
    }
    if (!query.data) return [];
    const doc = new Y.Doc();
    try {
      applySavedContent(doc, query.data);
      applyPendingSaves(doc, saveQueue.pending(moduleId));
      if (doc.store.pendingStructs || doc.store.pendingDs) return [];
      const saved: JSONContent = yDocToProsemirrorJSON(doc, "default");
      const content = saved.content ?? [];
      const numbers = numberHeadings(content.flatMap((node, pos) => node.type === "heading" ? [{ pos, level: Number(node.attrs?.level) }] : []));
      return content.flatMap((node, pos) => {
        const id = node.attrs?.["data-toc-id"];
        if (node.type !== "heading" || Number(node.attrs?.level) !== 1) return [];
        const text = (item: JSONContent): string => item.text ?? (item.content ?? []).map(text).join("");
        const known = typeof id === "string" && id ? id : null;
        return [{ id: known, key: known ?? `pos-${pos}`, title: text(node).trim() || UNTITLED_SECTION, number: numbers.get(pos) ?? "" }];
      });
    } finally { doc.destroy(); }
  }, [live, query.data, moduleId]);
  return { sections, focusedId, loading: !editor && query.isPending, error: !editor && query.error };
}

// Wait for the destination editor and its saved view before applying navigation.
export function SidebarSectionNavigation() {
  const { activeEditor } = useActiveEditor();
  const request = useSelector(destination, state => state);
  useEffect(() => {
    if (!request || !activeEditor?.isReady || activeEditor.moduleId !== request.moduleId || activeEditor.editor.isDestroyed) return;
    const { editor } = activeEditor;
    if (request.addSection && !editor.isEditable) {
      toast.error("This note is read-only. A section could not be added.");
      destination.setState(() => null);
      return;
    }
    stopScrollRestore();
    const container = editorHost.scrollContainer(editor.view.dom);
    if (container) beginHostNavigation(container);
    if (request.addSection) {
      const end = editor.state.doc.content.size;
      editor.chain().showDocument()
        .insertContentAt(end, { type: "heading", attrs: { level: 1, "data-toc-id": crypto.randomUUID() } })
        .setTextSelection(end + 1).focus().scrollIntoView().run();
    } else if (request.headingId === null) {
      const pos = sectionFocusKey.getState(editor.state);
      const heading = pos == null ? null : editor.view.nodeDOM(pos);
      const before = heading instanceof HTMLElement ? heading.getBoundingClientRect().top : null;
      editor.commands.showDocument();
      if (container && heading instanceof HTMLElement && before !== null) container.scrollTop += heading.getBoundingClientRect().top - before;
    } else {
      const heading = outline(editor.state.doc).find(item => item.id === request.headingId);
      if (heading) {
        const hidden = new Set(getFoldedRanges(editor.state).filter(range => range.heading === heading.pos || (heading.pos >= range.from && heading.pos < range.to)).map(range => range.id));
        if (hidden.size) editor.commands.setFolds(getFoldedIds(editor.state).filter(id => !hidden.has(id)));
        editor.chain().setTextSelection(heading.pos + 1).showSection(heading.pos).run();
        const element = editor.view.nodeDOM(heading.pos);
        if (element instanceof HTMLElement) element.scrollIntoView({ block: "start", behavior: "instant" });
      }
    }
    destination.setState(() => null);
  }, [request, activeEditor]);
  return null;
}
