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
import { useActiveEditor } from "@/lib/active-editor-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const inputClassName =
  "h-7 min-w-0 flex-1 rounded-md bg-input/50 px-2 text-sm outline-none placeholder:text-muted-foreground dark:bg-input/30";

export function FindBar() {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.editor ?? null;

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
      if (!editor || editor.isDestroyed) return { count: 0, current: null };
      const storage = editor.storage.findAndReplace;
      return { count: storage.results.length, current: storage.currentIndex };
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
    editor.commands.setSearchTerm(searchTerm);
  }, [editor, isOpen, searchTerm, replaceTerm, caseSensitive, useRegex]);

  // A fresh search marks the first match without selecting it, so reveal it here.
  useEffect(() => {
    if (!editor || editor.isDestroyed || search?.current == null) return;
    editor.view.dom
      .querySelector(".find-and-replace-result-current")
      ?.scrollIntoView({ block: "nearest" });
  }, [editor, search?.count, search?.current]);

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

      if (event.altKey) setShowReplace(true);
      setIsOpen(true);
      requestAnimationFrame(() => {
        const input =
          event.altKey ? replaceInput.current : searchInput.current;
        input?.focus();
        input?.select();
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editor]);

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

  const goToNext = () => editor.commands.goToNextResult();
  const goToPrevious = () => editor.commands.goToPreviousResult();

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
              handleKeyDown(event, () => editor.commands.replace())
            }
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Replace"
            disabled={!hasResults}
            onClick={() => editor.commands.replace()}
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
