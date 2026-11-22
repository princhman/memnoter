import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { RegisteredRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createStore, useSelector } from "@tanstack/react-store";
import type { JSONContent } from "@tiptap/core";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { useActiveEditor } from "./active-editor-context";
import { call } from "./backend";
import { applySavedContent, contentQueryOptions, sidebarSectionsKey, type GetContentResponse } from "./content";
import { applyPendingSaves, saveQueue } from "./saves";
import { outline, TOC_ID_ATTRIBUTE, UNTITLED_SECTION } from "./outline";
import { sectionFocusKey } from "./section-focus";
import { getFoldedIds, getFoldedRanges } from "./heading-fold";
import { beginHostNavigation, editorHost } from "./editor-host";
import { stopScrollRestore } from "./view-persistence";
import { setModulePage } from "./store";
import { headingNumbers, numberHeadings } from "./heading-numbering";
import { isNoteFromNewerVersion } from "./editor-schema";
import { toast } from "sonner";

type SectionTarget = { kind: "heading"; id: string } | { kind: "legacy-heading"; chapterIndex: number };
type Section = { target: SectionTarget; key: string; title: string; number: string };
type SidebarTarget = SectionTarget | { kind: "document" } | { kind: "add" };
type SidebarRequest = { moduleId: string; target: SidebarTarget };
const destination = createStore<SidebarRequest | null>(null);
let pendingRequest: { pathname: string; cancel: () => void } | null = null;

export function pendingSidebarSectionCancellation(pathname: string, action: string) {
  const pending = pendingRequest;
  if (pending?.pathname === pathname && (action === "PUSH" || action === "REPLACE")) return pending.cancel;
  // Starting a different navigation supersedes the request even while saves drain.
  pending?.cancel();
}

export function openSidebarSection(moduleId: string, target: SidebarTarget, router: RegisteredRouter) {
  pendingRequest?.cancel();
  const request: SidebarRequest = { moduleId, target };
  const id = crypto.randomUUID();
  const route = { to: "/$moduleId", params: { moduleId } } as const;
  const { pathname, publicHref } = router.buildLocation(route);
  const publish = () => {
    setModulePage(moduleId, "notes");
    destination.setState(() => request);
  };
  const cancel = () => {
    unsubscribe();
    if (pendingRequest?.cancel === cancel) pendingRequest = null;
    if (destination.state === request) destination.setState(() => null);
  };
  const unsubscribe = router.history.subscribe(({ location, action }) => {
    // Only the first commit of this navigation can arm the request.
    // A different navigation, including Back, cancels it even during loading.
    if (destination.state === request || (action.type !== "PUSH" && action.type !== "REPLACE") ||
      !("sidebarSectionRequest" in location.state) || location.state.sidebarSectionRequest !== id) {
      cancel();
      return;
    }
    publish();
  });
  pendingRequest = { pathname, cancel };
  if (router.history.location.href === publicHref) {
    publish();
    return;
  }
  void router.navigate({
    ...route,
    state: state => ({ ...state, sidebarSectionRequest: id }),
  }).catch(cancel);
}

function sectionTarget(id: string | null, chapterIndex: number): SectionTarget {
  return id ? { kind: "heading", id } : { kind: "legacy-heading", chapterIndex };
}

function sectionKey(target: SectionTarget) {
  return target.kind === "heading" ? target.id : `chapter-${target.chapterIndex}`;
}

export function useSidebarSections(moduleId: string, expanded: boolean) {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.moduleId === moduleId && activeEditor.isReady && !activeEditor.editor.isDestroyed ? activeEditor.editor : null;
  // useEditorState retains its last snapshot when its editor becomes null.
  // Read from the current editor directly so closed notes use saved content
  // again when leaving the editor.
  const subscribe = useCallback((notify: () => void) => {
    if (!editor) return () => {};
    editor.on("transaction", notify);
    return () => { editor.off("transaction", notify); };
  }, [editor]);
  const snapshot = useCallback(() => editor && !editor.isDestroyed ? editor.state : null, [editor]);
  const liveState = useSyncExternalStore(subscribe, snapshot, () => null);
  const live = liveState?.doc ?? null;
  const focusedKey = useMemo(() => {
    if (!liveState) return null;
    const pos = sectionFocusKey.getState(liveState);
    // Highlight the parent H1 even when a subsection was focused from Contents.
    if (pos == null) return null;
    const chapters = outline(liveState.doc).filter(item => item.level === 1);
    const index = chapters.findIndex(item => item.pos <= pos && item.end > pos);
    return index < 0 ? null : sectionKey(sectionTarget(chapters[index].id, index));
  }, [liveState]);
  const query = useQuery({
    ...contentQueryOptions(moduleId),
    queryKey: sidebarSectionsKey(moduleId),
    queryFn: () => call<GetContentResponse>("get_content", { moduleId }),
    enabled: expanded && !editor,
    staleTime: Infinity,
  });
  const sections = useMemo<Section[] | null>(() => {
    if (live) {
      const numbers = headingNumbers(live);
      // Every numbered H1 is listed, so the sidebar never skips a chapter number.
      return outline(live).filter(item => item.level === 1).map((item, index) => {
        const target = sectionTarget(item.id, index);
        return { target, key: sectionKey(target), title: item.title, number: numbers.get(item.pos) ?? "" };
      });
    }
    if (!query.data) return [];
    const doc = new Y.Doc();
    try {
      applySavedContent(doc, query.data);
      applyPendingSaves(doc, saveQueue.pending(moduleId));
      if (doc.store.pendingStructs || doc.store.pendingDs) return [];
      if (isNoteFromNewerVersion(doc)) return null;
      const saved: JSONContent = yDocToProsemirrorJSON(doc, "default");
      const content = saved.content ?? [];
      const numbers = numberHeadings(content.flatMap((node, pos) => node.type === "heading" ? [{ pos, level: Number(node.attrs?.level) }] : []));
      const chapters = content.map((node, pos) => ({ node, pos }))
        .filter(({ node }) => node.type === "heading" && Number(node.attrs?.level) === 1);
      const text = (item: JSONContent): string => item.text ?? (item.content ?? []).map(text).join("");
      return chapters.map(({ node, pos }, index) => {
        const id = node.attrs?.[TOC_ID_ATTRIBUTE];
        const target = sectionTarget(typeof id === "string" ? id : null, index);
        return { target, key: sectionKey(target), title: text(node).trim() || UNTITLED_SECTION, number: numbers.get(pos) ?? "" };
      });
    } catch {
      return null;
    } finally { doc.destroy(); }
  }, [live, query.data, moduleId]);
  return {
    sections: sections ?? [],
    focusedKey,
    canReorder: !!editor?.isEditable,
    loading: !editor && query.isPending,
    error: !editor && (query.isError || sections === null),
  };
}

// Wait for the destination editor and its saved view before applying navigation.
export function SidebarSectionNavigation() {
  const { activeEditor } = useActiveEditor();
  const request = useSelector(destination, state => state);
  useEffect(() => {
    if (!request || destination.state !== request || !activeEditor?.isReady || activeEditor.moduleId !== request.moduleId || activeEditor.editor.isDestroyed) return;
    const { editor } = activeEditor;
    const { target } = request;
    if (target.kind === "add" && !editor.isEditable) {
      toast.error("This note is read-only. A section could not be added.");
      pendingRequest?.cancel();
      return;
    }
    stopScrollRestore();
    const container = editorHost.scrollContainer(editor.view.dom);
    if (container) beginHostNavigation(container);
    if (target.kind === "add") {
      const end = editor.state.doc.content.size;
      editor.chain().showDocument()
        .insertContentAt(end, { type: "heading", attrs: { level: 1, "data-toc-id": crypto.randomUUID() } })
        .setTextSelection(end + 1).focus().scrollIntoView().run();
    } else if (target.kind === "document") {
      const pos = sectionFocusKey.getState(editor.state);
      const heading = pos == null ? null : editor.view.nodeDOM(pos);
      const before = heading instanceof HTMLElement ? heading.getBoundingClientRect().top : null;
      editor.commands.showDocument();
      if (container && heading instanceof HTMLElement && before !== null) container.scrollTop += heading.getBoundingClientRect().top - before;
    } else {
      const headings = outline(editor.state.doc);
      // Loading assigns ids to legacy headings. Their top-level chapter order
      // identifies them across that assignment.
      const heading = target.kind === "heading"
        ? headings.find(item => item.id === target.id)
        : headings.filter(item => item.level === 1)[target.chapterIndex];
      if (heading) {
        const hidden = new Set(getFoldedRanges(editor.state).filter(range => range.heading === heading.pos || (heading.pos >= range.from && heading.pos < range.to)).map(range => range.id));
        if (hidden.size) editor.commands.setFolds(getFoldedIds(editor.state).filter(id => !hidden.has(id)));
        editor.chain().setTextSelection(heading.pos + 1).showSection(heading.pos).run();
        const element = editor.view.nodeDOM(heading.pos);
        if (element instanceof HTMLElement) element.scrollIntoView({ block: "start", behavior: "instant" });
      }
    }
    if (destination.state === request) pendingRequest?.cancel();
  }, [request, activeEditor]);
  return null;
}
