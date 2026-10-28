import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useEditorState } from "@tiptap/react";
import { useSelector } from "@tanstack/react-store";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Regex,
  Replace,
  ReplaceAll,
  X,
} from "lucide-react";
import type { Editor } from "@tiptap/core";
import { useActiveEditor } from "@/lib/active-editor-context";
import { getFoldedRanges, headingFoldKey } from "@/lib/heading-fold";
import { getFocusedSectionRange } from "@/lib/section-focus";
import { scrollCurrentResultIntoView } from "@/lib/find-highlights";
import { clearFindRequest, findRequestStore } from "@/lib/find-request";
import { stopScrollRestore } from "@/lib/view-persistence";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const inputClassName =
  "h-7 min-w-0 flex-1 rounded-md bg-input/50 px-2 text-sm outline-none placeholder:text-muted-foreground dark:bg-input/30";

// A match outside the focused section or inside a fold is hidden, so show it first.
function revealCurrentResult(editor: Editor) {
  const { results, currentIndex } = editor.storage.findAndReplace;
  const match = currentIndex == null ? undefined : results[currentIndex];
  if (match) {
    const focused = getFocusedSectionRange(editor.state);
    if (focused && (match.from < focused.from || match.to > focused.to)) {
      editor.commands.showDocument();
    }
    // Unfold only what covers the match; other ids stay, even ones kept for undo.
    const covering = new Set(
      getFoldedRanges(editor.state)
        .filter((range) => match.from < range.to && match.to > range.from)
        .map((range) => range.id),
    );
    if (covering.size) {
      const folded = headingFoldKey.getState(editor.state)?.folded ?? [];
      editor.commands.setFolds(folded.filter((id) => !covering.has(id)));
    }
  }
  scrollCurrentResultIntoView(editor.view);
}

// Terms from a find request still to try, the first being the one searched.
type PendingFind = { terms: string[] };

export function FindBar() {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.editor ?? null;
  const isReady = activeEditor?.isReady ?? false;
  const findRequest = useSelector(findRequestStore, (request) => request);
  const pendingFind = useRef<PendingFind | null>(null);
  // Changes per request, so asking again for the applied term still reveals.
  const [requestCount, setRequestCount] = useState(0);

  const [isOpen, setIsOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [replaceTerm, setReplaceTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);

  const search = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor || editor.isDestroyed) {
        return { count: 0, current: null, applied: "" };
      }
      const storage = editor.storage.findAndReplace;
      return {
        count: storage.results.length,
        current: storage.currentIndex,
        // The search term is debounced; this changes once its results are in.
        applied: `${storage.caseSensitive}:${storage.useRegex}:${storage.searchTerm}`,
      };
    },
  });

  // The bar's fields are the source of truth; a newly opened note picks them up.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (!isOpen) {
      editor.commands.clearSearch();
      return;
    }
    editor
      .chain()
      .setCaseSensitive(caseSensitive)
      .setUseRegex(useRegex)
      .setReplaceTerm(replaceTerm)
      .run();
  }, [editor, isOpen, replaceTerm, caseSensitive, useRegex]);

  // Resubmitting the same term would reset the current match, so only send changes.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !isOpen) return;
    editor.commands.setSearchTerm(searchTerm);
  }, [editor, isOpen, searchTerm]);

  // A fresh search marks the first match without selecting it, so reveal it here.
  // Edits also change the results, but must not move the view or unfold. A note
  // that finishes loading counts as fresh, once its saved view is restored.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !isReady) return;

    const pending = pendingFind.current;
    if (pending) {
      // Wait for the requested term's results, then fall back to the next term.
      if (search?.applied !== `false:false:${pending.terms[0]}`) return;
      if (search.current == null) {
        const [, ...rest] = pending.terms;
        pendingFind.current = rest.length ? { terms: rest } : null;
        if (rest.length) setSearchTerm(rest[0]);
        return;
      }
      pendingFind.current = null;
      // The match, not the restored scroll position, is what to show now.
      stopScrollRestore();
      revealCurrentResult(editor);
      const { results, currentIndex } = editor.storage.findAndReplace;
      const match = results[currentIndex ?? 0];
      if (match) editor.commands.setTextSelection(match);
      return;
    }

    if (search?.current == null) return;
    revealCurrentResult(editor);
  }, [editor, isReady, search?.applied, requestCount]);

  const open = (focusReplace: boolean) => {
    if (focusReplace) setShowReplace(true);
    setIsOpen(true);
    requestAnimationFrame(() => {
      const input = focusReplace ? replaceInput.current : searchInput.current;
      input?.focus();
      input?.select();
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.code !== "KeyF")
        return;
      event.preventDefault();

      // Seed the search with a short single-line selection, like most editors.
      if (editor && !editor.isDestroyed) {
        const { from, to, empty } = editor.state.selection;
        const selected = empty ? "" : editor.state.doc.textBetween(from, to);
        if (selected && !selected.includes("\n") && selected.length <= 200) {
          setSearchTerm(selected);
        }
      }

      open(event.altKey);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editor]);

  // Requests run once their note is open and has restored its view.
  useEffect(() => {
    if (!findRequest || !editor || editor.isDestroyed || !isReady) return;
    if (findRequest.moduleId && findRequest.moduleId !== activeEditor?.moduleId) {
      return;
    }
    clearFindRequest();

    const terms = findRequest.terms.filter(Boolean);
    if (terms.length) {
      // The terms are plain text from the search index.
      setCaseSensitive(false);
      setUseRegex(false);
      setSearchTerm(terms[0]);
      pendingFind.current = { terms };
      setRequestCount((count) => count + 1);
    }
    open(false);
  }, [findRequest, editor, isReady, activeEditor?.moduleId]);

  if (!isOpen || !editor || editor.isDestroyed) return null;

  const hasResults = (search?.count ?? 0) > 0;

  const close = () => {
    pendingFind.current = null;
    setIsOpen(false);
    if (!editor.isDestroyed) editor.commands.focus();
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    onEnter: () => void,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      onEnter();
    }
  };

  const goToNext = () => {
    editor.commands.goToNextResult();
    revealCurrentResult(editor);
  };
  const goToPrevious = () => {
    editor.commands.goToPreviousResult();
    revealCurrentResult(editor);
  };
  // Replace moves on to the next match, which may be hidden.
  const replace = () => {
    editor.commands.replace();
    revealCurrentResult(editor);
  };

  return (
    <div className="absolute top-10 right-4 z-40 flex w-80 flex-col gap-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md">
      <div className="flex items-center gap-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Toggle replace"
          aria-expanded={showReplace}
          onClick={() => setShowReplace((value) => !value)}
        >
          {showReplace ? <ChevronDown /> : <ChevronRight />}
        </Button>
        <input
          ref={searchInput}
          className={inputClassName}
          placeholder="Find"
          value={searchTerm}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setSearchTerm(event.target.value)}
          onKeyDown={(event) =>
            handleKeyDown(event, event.shiftKey ? goToPrevious : goToNext)
          }
        />
        <span className="w-12 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
          {searchTerm
            ? hasResults
              ? `${(search?.current ?? 0) + 1}/${search?.count}`
              : "0/0"
            : ""}
        </span>
        <ToggleButton
          label="Match case"
          pressed={caseSensitive}
          onToggle={() => setCaseSensitive((value) => !value)}
        >
          <CaseSensitive />
        </ToggleButton>
        <ToggleButton
          label="Use regular expression"
          pressed={useRegex}
          onToggle={() => setUseRegex((value) => !value)}
        >
          <Regex />
        </ToggleButton>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous match"
          disabled={!hasResults}
          onClick={goToPrevious}
        >
          <ChevronUp />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next match"
          disabled={!hasResults}
          onClick={goToNext}
        >
          <ChevronDown />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={close}>
          <X />
        </Button>
      </div>
      {showReplace && (
        <div className="flex items-center gap-1 pl-7">
          <input
            ref={replaceInput}
            className={inputClassName}
            placeholder="Replace"
            value={replaceTerm}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setReplaceTerm(event.target.value)}
            onKeyDown={(event) =>
              handleKeyDown(event, replace)
            }
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Replace"
            disabled={!hasResults}
            onClick={replace}
          >
            <Replace />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Replace all"
            disabled={!hasResults}
            onClick={() => editor.commands.replaceAll()}
          >
            <ReplaceAll />
          </Button>
        </div>
      )}
    </div>
  );
}

function ToggleButton({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      aria-pressed={pressed}
      className={cn(pressed && "bg-primary/15 text-primary hover:bg-primary/20")}
      onClick={onToggle}
    >
      {children}
    </Button>
  );
}
