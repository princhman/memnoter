import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useEditorState } from "@tiptap/react";
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
import { FIND_EVENT } from "@/lib/app-events";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import { cn, MOD_KEY } from "@/lib/utils";

const ALT_KEY = MOD_KEY === "⌘" ? "⌥" : "Alt+";
const SHIFT_KEY = MOD_KEY === "⌘" ? "⇧" : "Shift+";

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

export function FindBar() {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.editor ?? null;
  const isReady = activeEditor?.isReady ?? false;

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
    if (!editor || editor.isDestroyed || !isReady || search?.current == null) {
      return;
    }
    revealCurrentResult(editor);
  }, [editor, isReady, search?.applied]);

  const goToNext = () => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.goToNextResult();
    revealCurrentResult(editor);
  };
  const goToPrevious = () => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.goToPreviousResult();
    revealCurrentResult(editor);
  };

  const open = (withReplace: boolean) => {
    // Seed the search with a short single-line selection, like most editors.
    if (editor && !editor.isDestroyed) {
      const { from, to, empty } = editor.state.selection;
      const selected = empty ? "" : editor.state.doc.textBetween(from, to);
      if (selected && !selected.includes("\n") && selected.length <= 200) {
        setSearchTerm(selected);
      }
    }

    if (withReplace) setShowReplace(true);
    setIsOpen(true);
    requestAnimationFrame(() => {
      const input = withReplace ? replaceInput.current : searchInput.current;
      input?.focus();
      input?.select();
    });
  };

  // Rebound every render, so the handlers see the current state.
  const handlers = useRef({ open, goToNext, goToPrevious });
  handlers.current = { open, goToNext, goToPrevious };
  const canStep = isOpen && !!searchTerm;

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.code === "KeyF") {
        event.preventDefault();
        handlers.current.open(event.altKey);
      } else if (event.code === "KeyG" && canStep) {
        // Steps through matches from the editor, without going to the bar.
        event.preventDefault();
        if (event.shiftKey) handlers.current.goToPrevious();
        else handlers.current.goToNext();
      }
    };
    // The Find item of the app menu.
    const handleFind = () => handlers.current.open(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener(FIND_EVENT, handleFind);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(FIND_EVENT, handleFind);
    };
  }, [canStep]);

  if (!isOpen || !editor || editor.isDestroyed) return null;

  const hasResults = (search?.count ?? 0) > 0;

  const close = () => {
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

  // Replace moves on to the next match, which may be hidden.
  const replace = () => {
    editor.commands.replace();
    revealCurrentResult(editor);
  };

  return (
    <div className="absolute top-10 right-4 z-40 flex w-80 flex-col gap-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md">
      <div className="flex items-center gap-1">
        <IconTooltip
          label="Toggle replace"
          hint={`${MOD_KEY}${ALT_KEY}F`}
          side="bottom"
        >
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Toggle replace"
            aria-expanded={showReplace}
            onClick={() => setShowReplace((value) => !value)}
          >
            {showReplace ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </IconTooltip>
        <input
          ref={searchInput}
          aria-label="Find"
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
        <span
          aria-hidden="true"
          className="w-12 shrink-0 text-center text-xs text-muted-foreground tabular-nums"
        >
          {searchTerm
            ? hasResults
              ? `${(search?.current ?? 0) + 1}/${search?.count}`
              : "0/0"
            : ""}
        </span>
        {/* The count read out as it changes, in words rather than "3/10". */}
        <span aria-live="polite" aria-atomic="true" className="sr-only">
          {searchTerm
            ? hasResults
              ? `Match ${(search?.current ?? 0) + 1} of ${search?.count}`
              : "No matches"
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
        <IconTooltip
          label="Previous match"
          hint={`${MOD_KEY}${SHIFT_KEY}G`}
          side="bottom"
        >
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            disabled={!hasResults}
            onClick={goToPrevious}
          >
            <ChevronUp />
          </Button>
        </IconTooltip>
        <IconTooltip label="Next match" hint={`${MOD_KEY}G`} side="bottom">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            disabled={!hasResults}
            onClick={goToNext}
          >
            <ChevronDown />
          </Button>
        </IconTooltip>
        <IconTooltip label="Close" hint="Esc" side="bottom">
          <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={close}>
            <X />
          </Button>
        </IconTooltip>
      </div>
      {showReplace && (
        <div className="flex items-center gap-1 pl-7">
          <input
            ref={replaceInput}
            aria-label="Replace with"
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
          <IconTooltip label="Replace" hint="Enter" side="bottom">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Replace"
              disabled={!hasResults}
              onClick={replace}
            >
              <Replace />
            </Button>
          </IconTooltip>
          <IconTooltip label="Replace all" side="bottom">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Replace all"
              disabled={!hasResults}
              onClick={() => editor.commands.replaceAll()}
            >
              <ReplaceAll />
            </Button>
          </IconTooltip>
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
    <IconTooltip label={label} side="bottom">
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
    </IconTooltip>
  );
}
