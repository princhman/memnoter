import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { RegisteredRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createStore, useSelector } from "@tanstack/react-store";
import { useActiveEditor } from "./active-editor-context";
import { call } from "./backend";
import { contentQueryOptions, sidebarSectionsKey, type GetContentResponse } from "./content";
import { sectionFocusKey } from "./section-focus";
import { getFoldedIds, getFoldedRanges } from "./heading-fold";
import { beginHostNavigation, editorHost } from "./editor-host";
import { stopScrollRestore } from "./view-persistence";
import { setModulePage } from "./store";
import { editorFragment, focusedSidebarSection, liveSidebarSections, resolveSidebarSection, savedSidebarSections, type SidebarSection, type SidebarTarget } from "./sidebar-section-data";
import { toast } from "sonner";

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
  const fragment = liveState ? editorFragment(liveState) : null;
  const focusedKey = useMemo(() => liveState && focusedSidebarSection(liveState), [liveState]);
  const query = useQuery({
    ...contentQueryOptions(moduleId),
    queryKey: sidebarSectionsKey(moduleId),
    queryFn: () => call<GetContentResponse>("get_content", { moduleId }),
    enabled: expanded && !editor,
    staleTime: Infinity,
  });
  const sections = useMemo<SidebarSection[] | null>(() => {
    if (live) return liveSidebarSections(live, fragment);
    if (!query.data) return [];
    try {
      const result = savedSidebarSections(moduleId, query.data);
      return result.kind === "newer" ? null : result.kind === "ready" ? result.sections : [];
    } catch { return null; }
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
      editor.chain()
        .insertContentAt(end, { type: "heading", attrs: { level: 1, "data-toc-id": crypto.randomUUID() } })
        .setTextSelection(end + 1).showSection(end).focus().scrollIntoView().run();
    } else if (target.kind === "document") {
      const pos = sectionFocusKey.getState(editor.state);
      const heading = pos == null ? null : editor.view.nodeDOM(pos);
      const before = heading instanceof HTMLElement ? heading.getBoundingClientRect().top : null;
      editor.commands.showDocument();
      if (container && heading instanceof HTMLElement && before !== null) container.scrollTop += heading.getBoundingClientRect().top - before;
    } else {
      const heading = resolveSidebarSection(editor.state, target);
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
