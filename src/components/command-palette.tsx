import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { FileText, Search, SquareChevronRight } from "lucide-react";
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
import { requestFind } from "@/lib/find-request";
import { getRecentModuleIds } from "@/lib/recent-modules";
import { backfillSearchIndex } from "@/lib/search-index";
import { findTermsFor, splitMarked } from "@/lib/search-marks";
import type { Module } from "@/lib/types";

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 20;
const MAX_LISTED_NOTES = 50;
// Commands run once the palette has closed and returned focus; this is the
// fallback should the close animation never report finishing.
const AFTER_CLOSE_FALLBACK_MS = 300;

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
    id: "sidebar.toggle",
    title: "Toggle sidebar",
    shortcut: "⌘D",
    run: toggleSidebar,
  });

  // Only offered while a note is open; the request would otherwise wait.
  useEffect(() => {
    if (!hasEditor) return;
    return registerCommand({
      id: "find.open",
      title: "Find in note",
      shortcut: "⌘F",
      keywords: ["search"],
      run: () => requestFind({ moduleId: null, terms: [] }),
    });
  }, [hasEditor]);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether closing returns focus to where it was; opening a note moves it.
  const restoreFocus = useRef(true);
  const afterClose = useRef<(() => void) | null>(null);
  const navigate = useNavigate();
  const { activeEditor } = useActiveEditor();
  const commands = useCommands();
  const listId = useId();

  useBuiltinCommands();

  useEffect(() => {
    void backfillSearchIndex();
  }, []);

  // Captured on window, so the editor's own key handling never sees it.
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.code !== "KeyK"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      restoreFocus.current = true;
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const trimmed = query.trim();
  const debouncedQuery = useDebounced(trimmed, SEARCH_DEBOUNCE_MS);

  const modules = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
    enabled: open,
  });

  const search = useQuery({
    queryKey: ["search-notes", debouncedQuery],
    queryFn: () =>
      invoke<SearchResult[]>("search_notes", {
        query: debouncedQuery,
        limit: SEARCH_LIMIT,
      }),
    enabled: open && debouncedQuery !== "",
    placeholderData: keepPreviousData,
    // Notes are re-indexed as they change; never show an old search.
    gcTime: 0,
  });

  const groups = useMemo<Group[]>(() => {
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
      { id: "notes", label: trimmed ? "Notes" : "Recent notes", items: notes },
      { id: "commands", label: "Commands", items: commandItems },
    ].filter((group) => group.items.length > 0);
  }, [trimmed, debouncedQuery, search.data, modules.data, commands, open]);

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const itemsKey = items.map((item) => item.key).join("\n");
  const active = items[Math.min(activeIndex, items.length - 1)];

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

  const activate = (item: Item) => {
    if (item.kind === "command") {
      afterClose.current = () => {
        Promise.resolve(item.command.run()).catch((error) =>
          console.error(`Command ${item.command.id} failed:`, error),
        );
      };
      restoreFocus.current = true;
      setOpen(false);
      window.setTimeout(runAfterClose, AFTER_CLOSE_FALLBACK_MS);
      return;
    }

    const terms = trimmed ? findTermsFor(trimmed, item.snippet ?? "") : [];
    const isOpenNote = activeEditor?.moduleId === item.moduleId;
    // The find bar or the opened note takes focus instead.
    restoreFocus.current = isOpenNote && terms.length === 0;
    setOpen(false);
    if (terms.length) requestFind({ moduleId: item.moduleId, terms });
    if (!isOpenNote) {
      void navigate({ to: "/$moduleId", params: { moduleId: item.moduleId } });
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!count) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (Math.min(index, count - 1) + step + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) activate(active);
    }
  };

  const optionId = (item: Item) => `${listId}-${item.key}`;
  const isSearching = trimmed !== "" && (trimmed !== debouncedQuery || search.isFetching);

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        setQuery("");
        runAfterClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        finalFocus={() => restoreFocus.current}
        className="top-[18vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl data-open:zoom-in-100"
      >
        <DialogTitle className="sr-only">Search notes and commands</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            aria-label="Search notes and commands"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search notes and commands"
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
                {group.label}
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
                    </>
                  ) : (
                    <>
                      <SquareChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {item.command.title}
                      </span>
                      {item.command.shortcut && (
                        <kbd className="shrink-0 font-sans text-xs text-muted-foreground">
                          {item.command.shortcut}
                        </kbd>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
          {items.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              {isSearching ? "Searching…" : trimmed ? "No matches" : "No notes yet"}
            </div>
          )}
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
