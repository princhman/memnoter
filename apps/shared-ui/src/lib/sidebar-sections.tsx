import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { RegisteredRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createStore, useSelector } from "@tanstack/react-store";
import type { JSONContent } from "@tiptap/core";
import { ProsemirrorBinding, yDocToProsemirrorJSON, ySyncPluginKey } from "@tiptap/y-tiptap";
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

type SectionTarget = { kind: "heading"; id: string } | { kind: "legacy-heading"; itemId: Y.ID };
type Section = { target: SectionTarget; key: string; title: string; number: string };
type SidebarTarget = SectionTarget | { kind: "document" } | { kind: "add" };
type SidebarRequest = { moduleId: string; target: SidebarTarget };
const destination = createStore<SidebarRequest | null>(null);
let pendingRequest: { id: string; cancel: () => void } | null = null;

export function guardSidebarSectionNavigation(state: object, action: string) {
  if ((action === "PUSH" || action === "REPLACE") && "sidebarSectionRequest" in state) {
    const request = pendingRequest?.id === state.sidebarSectionRequest ? pendingRequest : null;
    return {
      isSuperseded: () => !request || pendingRequest !== request,
      cancel: () => request?.cancel(),
    };
  }
  // Starting a different navigation supersedes the request even while saves drain.
  pendingRequest?.cancel();
}

export function openSidebarSection(moduleId: string, target: SidebarTarget, router: RegisteredRouter) {
  pendingRequest?.cancel();
  const request: SidebarRequest = { moduleId, target };
  const id = crypto.randomUUID();
  const route = { to: "/$moduleId", params: { moduleId } } as const;
  const { publicHref } = router.buildLocation(route);
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
  pendingRequest = { id, cancel };
  if (router.history.location.href === publicHref) {
    publish();
    return;
  }
  void router.navigate({
    ...route,
    state: state => ({ ...state, sidebarSectionRequest: id }),
  }).catch(cancel);
}

function sectionTarget(id: string | null, getItem: () => unknown): SectionTarget | null {
  if (id) return { kind: "heading", id };
  const item = getItem();
  if (!(item instanceof Y.XmlElement)) return null;
  // Anchor to the heading element itself, independent of its text or neighbours.
  const { type: itemId } = Y.createRelativePositionFromTypeIndex(item, 0, -1);
  return itemId ? { kind: "legacy-heading", itemId } : null;
}

function sectionKey(target: SectionTarget) {
  return target.kind === "heading" ? target.id : `chapter-${target.itemId.client}-${target.itemId.clock}`;
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
  const binding: unknown = liveState && ySyncPluginKey.getState(liveState)?.binding;
  const fragment = binding instanceof ProsemirrorBinding ? binding.type : null;
  const focusedKey = useMemo(() => {
    if (!liveState) return null;
    const pos = sectionFocusKey.getState(liveState);
    // Highlight the parent H1 even when a subsection was focused from Contents.
    if (pos == null) return null;
    const chapter = outline(liveState.doc).find(item => item.level === 1 && item.pos <= pos && item.end > pos);
    if (!chapter) return null;
    const target = sectionTarget(chapter.id, () => fragment?.get(liveState.doc.resolve(chapter.pos).index()));
    return target ? sectionKey(target) : null;
  }, [liveState, fragment]);
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
      return outline(live).filter(item => item.level === 1).flatMap(item => {
        const target = sectionTarget(item.id, () => fragment?.get(live.resolve(item.pos).index()));
        return target ? [{ target, key: sectionKey(target), title: item.title, number: numbers.get(item.pos) ?? "" }] : [];
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
      const seenIds = new Set<string>();
      const duplicateIds = new Set<string>();
      // The editor's TOC repairs duplicate IDs across the whole document.
      // Use Yjs identity whenever that repair could change a sidebar target.
      function collectIds(node: JSONContent) {
        if (node.type === "heading") {
          const id = node.attrs?.[TOC_ID_ATTRIBUTE];
          if (typeof id === "string" && id) {
            if (seenIds.has(id)) duplicateIds.add(id);
            seenIds.add(id);
          }
        }
        node.content?.forEach(collectIds);
      }
      collectIds(saved);
      const headings = content.flatMap((node, pos) => {
        if (node.type !== "heading") return [];
        const attr = node.attrs?.[TOC_ID_ATTRIBUTE];
        const id = typeof attr === "string" && attr ? attr : null;
        return [{ node, pos, level: Number(node.attrs?.level), id }];
      });
      const numbers = numberHeadings(headings);
      const chapters = headings.filter(({ level }) => level === 1);
      const text = (item: JSONContent): string => item.text ?? (item.content ?? []).map(text).join("");
      const blocks = doc.getXmlFragment("default").toArray();
      return chapters.flatMap(({ node, pos, id }) => {
        const target = sectionTarget(id && !duplicateIds.has(id) ? id : null, () => blocks[pos]);
        return target ? [{ target, key: sectionKey(target), title: text(node).trim() || UNTITLED_SECTION, number: numbers.get(pos) ?? "" }] : [];
      });
    } catch {
      return null;
    } finally { doc.destroy(); }
  }, [live, fragment, query.data, moduleId]);
  return {
    sections: sections ?? [],
    focusedKey,
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
      const { state } = editor;
      const chapters = outline(state.doc).filter(item => item.level === 1);
      const binding: unknown = ySyncPluginKey.getState(state)?.binding;
      let legacyNode: unknown;
      if (target.kind === "legacy-heading" && binding instanceof ProsemirrorBinding) {
        const anchor = new Y.RelativePosition(target.itemId, null, null);
        const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, binding.doc, false);
        if (resolved?.type instanceof Y.XmlElement && resolved.type.parent === binding.type) {
          legacyNode = binding.mapping.get(resolved.type);
        }
      }
      const heading = target.kind === "heading"
        ? chapters.find(item => item.id === target.id)
        : chapters.find(item => state.doc.nodeAt(item.pos) === legacyNode);
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
