import { Kbd } from "@/components/ui/kbd";
import { action, formatKeys, matchesShortcut } from "@/lib/shortcuts";
import { useModules } from "@/lib/modules";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { appStore, setModulePage } from "@/lib/store";
import { capabilities, call as invoke } from "../lib/backend.ts";
import { IS_WINDOWS } from "@/lib/platform";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileText, Search, SquareChevronRight } from "lucide-react";
import { headingNumbers } from "@/lib/heading-numbering";
import { headingTitleHtml } from "@/components/table-of-contents";
import type { Node as PMNode } from "@tiptap/pm/model";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSidebar } from "@/components/ui/sidebar";
import { useActiveEditor } from "@/lib/active-editor-context";
import {
  matchesCommand,
  registerCommand,
  useCommand,
  useCommands,
  type Command,
} from "@/lib/commands";
import { FIND_EVENT, requestApp } from "@/lib/app-events";
import { requestFind } from "@/lib/find-request";
import { getRecentModuleIds } from "@/lib/recent-modules";
import { isWriteAdmitted, isRestoring } from "@/lib/write-lifecycle";
import { findTermsFor, splitMarked } from "@/lib/search-marks";

import { outline, type OutlineHeading } from "@/lib/outline";
import { loadStoredNote } from "@/lib/note-index";
import { getSchema } from "@tiptap/core";
import { noteExtensions } from "@/lib/editor-schema";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import { useEditorState } from "@tiptap/react";
import { execEditor } from "@/editor-host/commands";

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 20;
const MAX_LISTED_NOTES = 50;
// Commands run once the palette has closed and returned focus; this is the
// fallback should the close animation never report finishing.

type SearchResult = {
  module_id: string;
  name: string;
  name_marked: string;
  snippet: string;
};

type Item =
  | {
      kind: "note";
      key: string;
      moduleId: string;
      name: string;
      nameMarked?: string;
      snippet?: string;
    }
  | { kind: "heading"; key: string; heading: OutlineHeading; hasChildren: boolean }
  | { kind: "command"; key: string; command: Command };

type Group = { id: string; label: string; items: Item[] };

function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}

function Marked({ text }: { text: string }) {
  return splitMarked(text).map((segment, index) =>
    segment.marked ? (
      <mark
        key={index}
        className="rounded-sm bg-primary/20 text-inherit dark:bg-primary/30"
      >
        {segment.text}
      </mark>
    ) : (
      segment.text
    ),
  );
}

function useBuiltinCommands() {
  const { toggleSidebar } = useSidebar();
  const { activeEditor } = useActiveEditor();
  const hasEditor = !!activeEditor;

  useCommand({
    ...action("sidebar.toggle"),
    run: toggleSidebar,
  });

  useEffect(() => {
    if (!IS_WINDOWS || !capabilities.windowControls) return;
    const entry = action("window.fullscreen");
    const appWindow = getCurrentWindow();
    let toggling = false;
    const run = async () => {
      if (toggling) return;
      toggling = true;
      try {
        await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
      } finally {
        toggling = false;
      }
    };
    const unregister = registerCommand({ ...entry, keywords: ["fullscreen"], run });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!matchesShortcut(event, entry.keys)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void run().catch(error => console.error("Failed to toggle full screen", error));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unregister();
    };
  }, []);

  // Only offered while a note is open; the request would otherwise wait.
  useEffect(() => {
    if (!hasEditor) return;
    return registerCommand({
      ...action("find.open"),
      keywords: ["search"],
      run: () => requestApp(FIND_EVENT),
    });
  }, [hasEditor]);
}

// Where a drilled-in palette is, in the window breadcrumb's shape:
// Module / Notes › Section / Subsection, with … before longer paths.
function PalettePath({ name, trail, titleHtml, inputRef, onModule, onHeading }: {
  name: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  titleHtml?: Map<number, string>;
  trail: { pos: number; title: string }[];
  onModule: () => void;
  onHeading: (pos: number) => void;
}) {
  // The last two sections, as in the window breadcrumb; earlier ones open from "…".
  const shown = trail.slice(-2);
  const hidden = trail.slice(0, -2);
  // Long titles shorten with an ellipsis; the current one keeps the most room.
  const crumb = (title: string, run: (() => void) | null, html?: string) => {
    const content = html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : title;
    return run
      ? <BreadcrumbLink title={title} className="block min-w-0 truncate" render={<button type="button" onMouseDown={event => event.preventDefault()} onClick={run} />}>{content}</BreadcrumbLink>
      : <BreadcrumbPage title={title} className="block min-w-0 truncate">{content}</BreadcrumbPage>;
  };
  return <Breadcrumb className="mr-auto min-w-0 flex-1 overflow-hidden text-xs">
    <BreadcrumbList className="flex-nowrap gap-1.5 text-xs whitespace-nowrap sm:gap-1.5 [&>[data-slot=breadcrumb-separator]]:shrink-0">
      <BreadcrumbItem className="max-w-[8rem] min-w-0 shrink-0 overflow-hidden">{crumb(name, trail.length ? onModule : null)}</BreadcrumbItem>
      <BreadcrumbSeparator>/</BreadcrumbSeparator>
      <BreadcrumbItem className="shrink-0">Notes</BreadcrumbItem>
      {hidden.length > 0 && <><BreadcrumbSeparator /><BreadcrumbItem className="shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Show parent sections" />}><BreadcrumbEllipsis className="size-4" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="min-w-56 max-w-80" finalFocus={inputRef}>
            {hidden.map(heading => <DropdownMenuItem key={heading.pos} onClick={() => onHeading(heading.pos)}>
              <span className="min-w-0 truncate">{titleHtml?.has(heading.pos) ? <span dangerouslySetInnerHTML={{ __html: titleHtml.get(heading.pos)! }} /> : heading.title}</span>
            </DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem></>}
      {shown.map((heading, index) => <Fragment key={heading.pos}>
        {index === 0 && hidden.length === 0 ? <BreadcrumbSeparator /> : <BreadcrumbSeparator>/</BreadcrumbSeparator>}
        <BreadcrumbItem className={cn("min-w-0 overflow-hidden", index === shown.length - 1 ? "flex-[0_1_auto]" : "flex-[0_2_auto]")}>{crumb(heading.title, index === shown.length - 1 ? null : () => onHeading(heading.pos), titleHtml?.get(heading.pos))}</BreadcrumbItem>
      </Fragment>)}
    </BreadcrumbList>
  </Breadcrumb>;
}

// Rendered titles for headings with inline math; plain titles need none.
function mathTitles(doc: PMNode) {
  const titles = new Map<number, string>();
  for (const { pos } of outline(doc)) {
    const node = doc.nodeAt(pos);
    let math = false;
    node?.forEach(child => { if (child.type.name === "inlineMath") math = true; });
    if (node && math) titles.set(pos, headingTitleHtml(node));
  }
  return titles;
}

// One schema for every outline read; building it from the extensions is not free.
let outlineSchema: ReturnType<typeof getSchema> | null = null;
// Kept briefly so a prefetch (highlighted row) serves the drill-in that follows;
// never reused across palette sessions long enough to show an old outline.
const outlineQuery = (moduleId: string) => ({
  queryKey: ["palette-outline", moduleId],
  gcTime: 5_000,
  staleTime: 5_000,
  queryFn: async () => {
    const doc = await loadStoredNote(moduleId);
    try {
      outlineSchema ??= getSchema(noteExtensions({ document: doc }));
      const node = outlineSchema.nodeFromJSON(yDocToProsemirrorJSON(doc, "default"));
      return { headings: outline(node), numbers: headingNumbers(node), titles: mathTitles(node) };
    } finally { doc.destroy(); }
  },
});

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const openRef = useRef(false);
  openRef.current = open;
  const [scope, setScope] = useState<{ moduleId: string; name: string; parent: number | null; moduleQuery: string } | null>(null);
  const [headingRequest, setHeadingRequest] = useState<{ moduleId: string; id: string | null; pos: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether closing returns focus to where it was; opening a note moves it.
  const restoreFocus = useRef(true);
  const afterClose = useRef<(() => void) | null>(null);
  const [instantClose, setInstantClose] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeEditor } = useActiveEditor();
  const matchRoute = useMatchRoute();
  // A module's note stays mounted behind its Questions page and the /questions
  // and /files pages, so an active editor alone doesn't mean the note is showing.
  const showingNote = (moduleId: string) => {
    const match = matchRoute({ to: "/$moduleId" });
    return activeEditor?.moduleId === moduleId && !!match && match.moduleId === moduleId
      && (appStore.state.modulePageByModule[moduleId] ?? "notes") === "notes";
  };
  const openNote = (moduleId: string) => {
    setModulePage(moduleId, "notes");
    const match = matchRoute({ to: "/$moduleId" });
    if (!match || match.moduleId !== moduleId) void navigate({ to: "/$moduleId", params: { moduleId } });
  };
  const commands = useCommands();
  const listId = useId();

  useBuiltinCommands();

  // Captured on window, so the editor's own key handling never sees it.
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!matchesShortcut(event, action("palette.open").keys)) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep the restore modal in control throughout its flush and DB swap.
      if (!isWriteAdmitted() || isRestoring()) return;
      // Inside the palette, the same keys open its actions, like Raycast;
      // Escape closes the palette.
      if (openRef.current) { setActionsOpen(value => !value); setActionIndex(0); return; }
      restoreFocus.current = true;
      setOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const trimmed = query.trim();
  const debouncedQuery = useDebounced(trimmed, SEARCH_DEBOUNCE_MS);

  const modules = useModules({ enabled: open, });

  const search = useQuery({
    queryKey: ["search-notes", debouncedQuery],
    queryFn: () =>
      invoke<SearchResult[]>("search_notes", {
        query: debouncedQuery,
        limit: SEARCH_LIMIT,
      }),
    enabled: open && !scope && debouncedQuery !== "",
    placeholderData: keepPreviousData,
    // Notes are re-indexed as they change; never show an old search.
    gcTime: 0,
  });

  const liveDoc = useEditorState({ editor: activeEditor?.editor ?? null,
    selector: ({ editor }) => editor?.state.doc, equalityFn: Object.is });
  const storedOutline = useQuery({
    ...outlineQuery(scope?.moduleId ?? ""),
    enabled: open && !!scope && activeEditor?.moduleId !== scope.moduleId,
  });
  const live = !!scope && activeEditor?.moduleId === scope.moduleId && !!liveDoc;
  const headings = live && liveDoc ? outline(liveDoc) : storedOutline.data?.headings ?? [];
  // Section numbers replace the row icon when the module numbers its headings.
  const numbered = !!scope && (modules.data ?? []).some(module => module.id === scope.moduleId && module.heading_numbering);
  const headingNumberMap = numbered ? (live && liveDoc ? headingNumbers(liveDoc) : storedOutline.data?.numbers) : undefined;
  const liveTitles = useMemo(() => live && liveDoc ? mathTitles(liveDoc) : null, [live, liveDoc]);
  const titleHtml = liveTitles ?? storedOutline.data?.titles;
  const parent = headings.find(heading => heading.pos === scope?.parent);

  useEffect(() => {
    if (open || !headingRequest || !activeEditor?.isReady || activeEditor.moduleId !== headingRequest.moduleId) return;
    const heading = outline(activeEditor.editor.state.doc).find(item => headingRequest.id ? item.id === headingRequest.id : item.pos === headingRequest.pos);
    if (heading) execEditor(activeEditor.editor, "scrollToHeading", { id: heading.id ?? `native-section:${heading.pos}`, revealHidden: true });
    activeEditor.editor.commands.focus(undefined, { scrollIntoView: false });
    setHeadingRequest(null);
  }, [open, headingRequest, activeEditor]);

  const groups = useMemo<Group[]>(() => {
    if (scope) {
      const rows = headings.filter(heading => trimmed
        ? heading.title.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase())
        : (heading.ancestors[heading.ancestors.length - 1]?.pos ?? null) === scope.parent);
      return [{ id: "headings", label: parent?.title ?? scope.name, items: rows.map(heading => ({
        kind: "heading", key: `heading:${heading.pos}`, heading,
        hasChildren: headings.some(child => child.ancestors[child.ancestors.length - 1]?.pos === heading.pos),
      })) }];
    }
    let notes: Item[];
    if (trimmed) {
      notes = debouncedQuery
        ? (search.data ?? []).map((result) => ({
            kind: "note",
            key: `note:${result.module_id}`,
            moduleId: result.module_id,
            name: result.name,
            nameMarked: result.name_marked,
            snippet: result.snippet,
          }))
        : [];
    } else {
      const recent = getRecentModuleIds();
      const rank = (id: string) => {
        const index = recent.indexOf(id);
        return index === -1 ? recent.length : index;
      };
      notes = [...(modules.data ?? [])]
        .sort((a, b) => rank(a.id) - rank(b.id))
        .slice(0, MAX_LISTED_NOTES)
        .map((module) => ({
          kind: "note",
          key: `note:${module.id}`,
          moduleId: module.id,
          name: module.name,
        }));
    }
    const commandItems: Item[] = commands
      .filter((command) => !trimmed || matchesCommand(command, trimmed))
      .map((command) => ({
        kind: "command",
        key: `command:${command.id}`,
        command,
      }));
    return [
      { id: "notes", label: "Modules", items: notes },
      { id: "commands", label: "Commands", items: commandItems },
    ].filter((group) => group.items.length > 0);
  }, [trimmed, debouncedQuery, search.data, modules.data, commands, open, scope, headings, parent]);

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const itemsKey = items.map((item) => item.key).join("\n");
  const active = items[Math.min(activeIndex, items.length - 1)];

  // What the highlighted row can do; the first is the footer's main action.
  const actions: { label: string; keys: string; run: () => void }[] = !active ? [] : [
    { label: active.kind === "command" ? "Run command" : active.kind === "note" ? "Open note" : "Open section", keys: "Enter", run: () => activate(active) },
    ...(active.kind === "note" || (active.kind === "heading" && active.hasChildren) ? [{ label: "Browse sections", keys: "Mod-Enter", run: () => drill(active) }] : []),
    ...(scope ? [{ label: parent ? "Back to parent section" : "Back to modules", keys: "ArrowLeft", run: () => back() }] : []),
  ];
  const runAction = (index: number) => { const chosen = actions[index]; setActionsOpen(false); chosen?.run(); };
  useEffect(() => { if (!open) setActionsOpen(false); }, [open]);
  useEffect(() => setActionsOpen(false), [active?.key]);

  // Read the highlighted module's sections ahead of a drill-in, after a short
  // pause so arrowing through the list doesn't load every note.
  const prefetchId = open && !scope && active?.kind === "note" && activeEditor?.moduleId !== active.moduleId ? active.moduleId : null;
  useEffect(() => {
    if (!prefetchId) return;
    const timer = window.setTimeout(() => { void queryClient.prefetchQuery(outlineQuery(prefetchId)); }, 120);
    return () => window.clearTimeout(timer);
  }, [prefetchId, queryClient]);

  useEffect(() => setActiveIndex(0), [itemsKey]);

  useEffect(() => {
    if (!active) return;
    document
      .getElementById(`${listId}-${active.key}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const handleOpenChange = (next: boolean) => {
    if (next) restoreFocus.current = true;
    setOpen(next);
  };

  const runAfterClose = () => {
    const action = afterClose.current;
    afterClose.current = null;
    action?.();
  };

  const drill = (item: Item) => {
    if (item.kind === "note") {
      if (trimmed && (trimmed !== debouncedQuery || search.isPlaceholderData)) return;
      setScope({ moduleId: item.moduleId, name: item.name, parent: null, moduleQuery: query });
    } else if (item.kind === "heading" && item.hasChildren) {
      setScope(current => current && { ...current, parent: item.heading.pos });
    } else return;
    setQuery("");
    setActiveIndex(0);
  };
  const back = () => {
    if (!scope) return;
    if (parent) setScope({ ...scope, parent: parent.ancestors[parent.ancestors.length - 1]?.pos ?? null });
    else { setQuery(scope.moduleQuery); setScope(null); }
    setActiveIndex(0);
  };

  const activate = (item: Item) => {
    if (item.kind === "heading" && scope) {
      restoreFocus.current = false;
      const request = { moduleId: scope.moduleId, id: item.heading.id, pos: item.heading.pos };
      // Jump as soon as the note is ready, not after the palette's ~150ms exit
      // animation; a jump into another note also skips that animation.
      const other = !showingNote(scope.moduleId);
      setHeadingRequest(request);
      if (other) setInstantClose(true);
      setOpen(false);
      if (other) openNote(scope.moduleId);
      return;
    }
    if (item.kind === "heading") return;
    if (item.kind === "command") {
      afterClose.current = () => {
        Promise.resolve(item.command.run()).catch((error) =>
          console.error(`Command ${item.command.id} failed:`, error),
        );
      };
      restoreFocus.current = true;
      setOpen(false);
      return;
    }

    // Results still on screen from the previous query are not this query's.
    if (trimmed && (trimmed !== debouncedQuery || search.isPlaceholderData)) return;

    const terms = trimmed ? findTermsFor(trimmed, item.snippet ?? "") : [];
    const isOpenNote = showingNote(item.moduleId);
    // The find bar or the opened note takes focus instead.
    restoreFocus.current = isOpenNote && terms.length === 0;
    setOpen(false);
    if (terms.length) requestFind({ moduleId: item.moduleId, terms });
    if (!isOpenNote) openNote(item.moduleId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (actionsOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActionIndex(index => (index + step + actions.length) % Math.max(1, actions.length));
        return;
      }
      if (event.key === "Enter") { event.preventDefault(); runAction(actionIndex); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setActionsOpen(false); return; }
      setActionsOpen(false);
    }
    const count = items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!count) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (Math.min(index, count - 1) + step + count) % count);
    } else if (event.key === "ArrowRight" || matchesShortcut(event.nativeEvent, "Mod-Enter")) {
      event.preventDefault();
      if (active) drill(active);
    } else if (scope && !query && (event.key === "ArrowLeft" || event.key === "Backspace")) {
      event.preventDefault();
      back();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) activate(active);
    }
  };

  const optionId = (item: Item) => `${listId}-${item.key}`;
  const isSearching = !scope && trimmed !== "" && (trimmed !== debouncedQuery || search.isFetching);

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        setInstantClose(false);
        setQuery("");
        setScope(null);
        runAfterClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        finalFocus={() => restoreFocus.current}
        className={instantClose ? "top-[18vh] translate-y-0 gap-0 overflow-hidden p-0 shadow-2xl ring-0 sm:max-w-2xl data-open:zoom-in-100 data-closed:animate-none" : "top-[18vh] translate-y-0 gap-0 overflow-hidden p-0 shadow-2xl ring-0 sm:max-w-2xl data-open:zoom-in-100"}
      >
        <DialogTitle className="sr-only">Search modules and commands</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            aria-label="Search modules and commands"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder={scope ? "Find a section" : "Search modules and commands"}
            value={query}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-[min(24rem,60vh)] overflow-y-auto p-1"
        >
          {groups.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-labelledby={`${listId}-${group.id}`}
              className="pb-1"
            >
              <div
                id={`${listId}-${group.id}`}
                role="presentation"
                className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
              >
                {group.id === "headings" && parent && titleHtml?.has(parent.pos)
                  ? <span dangerouslySetInnerHTML={{ __html: titleHtml.get(parent.pos)! }} /> : group.label}
              </div>
              {group.items.map((item) => (
                <div
                  key={item.key}
                  id={optionId(item)}
                  role="option"
                  aria-selected={item === active}
                  className="flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                  // Keep focus, and so typing, in the input.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (item !== active) setActiveIndex(items.indexOf(item));
                  }}
                  onClick={() => activate(item)}
                >
                  {item.kind === "note" ? (
                    <>
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">
                          <Marked text={item.nameMarked ?? item.name} />
                        </div>
                        {item.snippet && (
                          <div className="line-clamp-2 text-xs text-muted-foreground">
                            <Marked text={item.snippet} />
                          </div>
                        )}
                      </div>
                      {item === active && <Kbd>{formatKeys("Mod-Enter")}</Kbd>}
                    </>
                  ) : item.kind === "heading" ? (
                    <>
                      {headingNumberMap?.get(item.heading.pos) && <span className="shrink-0 tabular-nums text-muted-foreground">{headingNumberMap.get(item.heading.pos)}</span>}
                      <span className="min-w-0 flex-1 truncate">{titleHtml?.has(item.heading.pos) ? <span dangerouslySetInnerHTML={{ __html: titleHtml.get(item.heading.pos)! }} /> : item.heading.title}
                        {trimmed && item.heading.ancestors.length > 0 && <span className="block truncate text-xs text-muted-foreground">{item.heading.ancestors.map(heading => heading.title).join(" › ")}</span>}
                      </span>
                      {item.hasChildren && item === active && <Kbd>{formatKeys("Mod-Enter")}</Kbd>}
                    </>
                  ) : (
                    <>
                      <SquareChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {item.command.title}
                      </span>
                      {item.command.shortcut && (
                        <Kbd>
                          {item.command.shortcut}
                        </Kbd>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
          {items.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              {scope && storedOutline.isError ? "Could not load headings" : scope && storedOutline.isFetching ? "Loading headings…" : isSearching ? "Searching…" : trimmed ? "No matches" : scope ? "No headings" : "No modules yet"}
            </div>
          )}
        </div>
        <div className="relative flex items-center gap-3 px-3 py-1.5 text-xs text-muted-foreground">
          {scope ? <PalettePath name={scope.name} trail={parent ? [...parent.ancestors, parent] : []} titleHtml={titleHtml} inputRef={inputRef}
            onModule={() => { setScope({ ...scope, parent: null }); setQuery(""); setActiveIndex(0); }}
            onHeading={pos => { setScope({ ...scope, parent: pos }); setQuery(""); setActiveIndex(0); }} />
            : <span className="mr-auto">Modules and commands</span>}
          {actions[0] && <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => runAction(0)}
            className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 whitespace-nowrap text-foreground hover:bg-accent">
            {actions[0].label.split(" ")[0]} <Kbd>{formatKeys(actions[0].keys)}</Kbd>
          </button>}
          <button type="button" aria-expanded={actionsOpen} onMouseDown={event => event.preventDefault()} onClick={() => { setActionsOpen(value => !value); setActionIndex(0); }}
            className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 whitespace-nowrap hover:bg-accent aria-expanded:bg-accent">
            Actions <Kbd>{formatKeys(action("palette.open").keys)}</Kbd>
          </button>
          {actionsOpen && actions.length > 0 && <div role="menu" aria-label="Actions" className="floating-surface absolute right-2 bottom-full mb-1 w-60 rounded-lg p-1 text-sm shadow-xl">
            {actions.map((item, index) => <div key={item.label} role="menuitem" aria-selected={index === actionIndex}
              onMouseDown={event => event.preventDefault()} onMouseMove={() => setActionIndex(index)} onClick={() => runAction(index)}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 aria-selected:bg-accent aria-selected:text-accent-foreground">
              <span className="min-w-0 flex-1 truncate">{item.label}</span><Kbd>{formatKeys(item.keys)}</Kbd>
            </div>)}
          </div>}
        </div>
        <div aria-live="polite" className="sr-only">
          {open && !isSearching && trimmed
            ? `${items.length} ${items.length === 1 ? "result" : "results"}`
            : ""}
        </div>
      </DialogContent>
    </Dialog>
  );
}
