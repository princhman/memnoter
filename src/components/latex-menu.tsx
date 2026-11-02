import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import type { EditorState } from "@tiptap/pm/state";
import { PluginKey, TextSelection } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionMatch,
  type SuggestionProps,
  type Trigger,
} from "@tiptap/suggestion";
import katex from "katex";
import { searchLatex, type LatexEntry } from "@/lib/latex-symbols";
import { useActiveDescendant } from "@/hooks/use-active-descendant";
import { cn } from "@/lib/utils";

const MATH_NODES = new Set(["inlineMath", "mathBlock"]);
const USAGE_KEY = "latex-usage";
const latexSuggestKey = new PluginKey("latex-suggest");

function inMath(state: EditorState, pos: number) {
  return MATH_NODES.has(state.doc.resolve(pos).parent.type.name);
}

function readUsage(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function recordUse(entry: LatexEntry) {
  const usage = readUsage();
  usage[entry.label] = (usage[entry.label] ?? 0) + 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Ranking just won't learn this pick.
  }
}

// A command is an odd run of backslashes plus the letters around the caret, so
// `\\` (a line break) never opens the menu, and editing inside `\al|pha`
// replaces the whole word.
function findLatexMatch({ $position }: Trigger): SuggestionMatch {
  const before = $position.nodeBefore;
  if (!before?.isText) return null;
  const match = /(\\+)([A-Za-z]*)$/.exec(before.text!);
  if (!match || match[1].length % 2 === 0) return null;
  const after = $position.nodeAfter?.isText
    ? /^[A-Za-z]*/.exec($position.nodeAfter.text!)![0]
    : "";
  const from = $position.pos - match[2].length - 1;
  return {
    range: { from, to: $position.pos + after.length },
    query: match[2],
    text: `\\${match[2]}${after}`,
  };
}

function insertEntry(editor: Editor, range: Range, entry: LatexEntry) {
  const { insert, caret } = entry;
  if (inMath(editor.state, range.from)) {
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(insert, range.from, range.to);
        tr.setSelection(TextSelection.create(tr.doc, range.from + caret));
        return true;
      })
      .run();
    return;
  }
  // In prose the command becomes a new inline formula.
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertInlineMath(insert)
    .command(({ tr }) => {
      const end = tr.selection.from;
      tr.setSelection(TextSelection.create(tr.doc, end - insert.length + caret));
      return true;
    })
    .run();
}

// Tab inside a formula jumps to the next empty  {}  or  [] .
function jumpToNextSlot(editor: Editor) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || !MATH_NODES.has($from.parent.type.name)) return false;
  if (latexSuggestKey.getState(state)?.active) return false;
  const text = $from.parent.textContent;
  const slots = [
    text.indexOf("{}", $from.parentOffset),
    text.indexOf("[]", $from.parentOffset),
  ].filter((index) => index >= 0);
  if (!slots.length) return false;
  return editor.commands.setTextSelection($from.start() + Math.min(...slots) + 1);
}

export const LatexSuggest = Extension.create<
  Record<string, never>,
  { accepted: { from: number; text: string } | null }
>({
  name: "latex-suggest",
  // Arrow keys, Enter and Tab go to the open menu before math key handling.
  priority: 200,

  addStorage() {
    return { accepted: null };
  },

  addKeyboardShortcuts() {
    return { Tab: () => jumpToNextSlot(this.editor) };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;

    return [
      Suggestion<LatexEntry, LatexEntry>({
        editor: this.editor,
        pluginKey: latexSuggestKey,
        char: "\\",
        allowedPrefixes: null,
        decorationClass: "latex-suggestion",
        findSuggestionMatch: findLatexMatch,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if (MATH_NODES.has($from.parent.type.name)) return true;
          if ($from.parent.type.spec.code) return false;
          const code = state.schema.marks.code;
          if (code && state.doc.rangeHasMark(range.from, range.to, code)) return false;
          // In prose the backslash has to start a word, so paths like
          // C:\Users stay plain text.
          const before = state.doc.textBetween(
            Math.max($from.start(), range.from - 1),
            range.from,
          );
          return !/[\p{L}\p{N}:/\\]/u.test(before);
        },
        shouldShow: ({ editor, range, query }) => {
          if (!query) return false;
          // Just inserted: don't reopen on the command that was picked.
          const { accepted } = storage;
          if (accepted?.from === range.from && accepted.text === `\\${query}`) {
            return false;
          }
          storage.accepted = null;
          if (inMath(editor.state, range.from)) return true;
          return searchLatex(query, { strict: true, limit: 1 }).length > 0;
        },
        items: ({ editor, query }) =>
          searchLatex(query, {
            usage: readUsage(),
            strict: !inMath(editor.state, editor.state.selection.from),
          }),
        command: ({ editor, range, props: entry }) => {
          recordUse(entry);
          // From prose the source starts one step later, inside the new formula.
          const from = inMath(editor.state, range.from) ? range.from : range.from + 1;
          storage.accepted = { from, text: entry.insert };
          insertEntry(editor, range, entry);
        },
        render: () => {
          let renderer: ReactRenderer<LatexMenuHandle, LatexMenuProps> | null =
            null;
          let unmount: (() => void) | null = null;

          return {
            onStart: (props) => {
              renderer = new ReactRenderer(LatexMenu, {
                props,
                editor: props.editor,
                className: "z-50",
              });
              unmount = props.mount?.(renderer.element as HTMLElement) ?? null;
            },
            onUpdate: (props) => renderer?.updateProps(props),
            onKeyDown: (props) => renderer?.ref?.onKeyDown(props) ?? false,
            onExit: () => {
              unmount?.();
              renderer?.destroy();
              unmount = null;
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});

const iconCache = new Map<string, string>();

function renderIcon(tex: string, displayMode = false) {
  const key = `${displayMode ? "D" : "T"}${tex}`;
  let html = iconCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { throwOnError: false, displayMode });
    iconCache.set(key, html);
  }
  return html;
}

const DETAILS_WIDTH = 240;
// How long the pointer must rest on a row inside the safe triangle to select it.
const SAFE_TRIANGLE_DELAY_MS = 150;

type Point = { x: number; y: number };

// Is `point` inside the triangle from `apex` to the panel's near edge?
function inSafeTriangle(apex: Point, point: Point, panel: DOMRect, panelLeft: boolean) {
  const edge = panelLeft ? panel.right : panel.left;
  const top = { x: edge, y: panel.top - 4 };
  const bottom = { x: edge, y: panel.bottom + 4 };
  const side = (from: Point, to: Point) =>
    (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
  const sides = [side(apex, top), side(top, bottom), side(bottom, apex)];
  return sides.every((value) => value >= 0) || sides.every((value) => value <= 0);
}

function LatexDetails({ item, onPick }: {
  item: LatexEntry;
  onPick: (entry: LatexEntry) => void;
}) {
  return (
    <div className="grid gap-2 p-3">
      <div
        className="flex h-14 items-center justify-center overflow-hidden rounded-md bg-background text-base [&_.katex-display]:m-0"
        dangerouslySetInnerHTML={{ __html: renderIcon(item.preview, true) }}
      />
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-xs">{item.label}</span>
        <span className="shrink-0 text-[0.7rem] text-muted-foreground">
          {item.category}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {item.note ?? item.keywords.join(", ")}
      </p>
      {item.similar?.length ? (
        <div className="grid gap-1 border-t pt-2">
          <span className="text-[0.7rem] text-muted-foreground">
            Similar
          </span>
          {item.similar.map((other) => (
            <button
              key={other.label}
              type="button"
              className="grid grid-cols-[1.75rem_1fr] items-center gap-x-2 rounded-md px-1 py-1 text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => onPick(other)}
            >
              <span
                className="flex h-5 items-center justify-center overflow-hidden text-[0.65rem]"
                dangerouslySetInnerHTML={{ __html: renderIcon(other.preview) }}
              />
              <span className="truncate font-mono text-[0.7rem]">{other.label}</span>
              {other.note ? (
                <span className="col-span-2 mt-0.5 text-[0.7rem] leading-snug text-muted-foreground">
                  {other.note}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type LatexMenuProps = SuggestionProps<LatexEntry, LatexEntry>;
type LatexMenuHandle = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

const LatexMenu = forwardRef<LatexMenuHandle, LatexMenuProps>(
  ({ items, command, query, editor, range }, ref) => {
    const [selected, setSelected] = useState(0);
    const [detailsLeft, setDetailsLeft] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const listboxId = useId();
    const optionId = (index: number) => `${listboxId}-${index}`;
    useActiveDescendant(editor, listboxId, items.length ? optionId(selected) : null);
    // Last pointer position over the selected row, the safe triangle's tip.
    const apex = useRef<Point | null>(null);
    const pending = useRef<number | undefined>(undefined);
    const cancelPending = () => window.clearTimeout(pending.current);

    useEffect(() => setSelected(0), [items]);

    useEffect(() => {
      apex.current = null;
      cancelPending();
    }, [selected, items]);

    useEffect(() => cancelPending, []);

    // Moving diagonally toward the details panel crosses other rows; don't
    // let those steal the selection unless the pointer settles on one.
    const handlePointerMove = (event: MouseEvent) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (!row) return;
      const index = Number(row.dataset.index);
      const point = { x: event.clientX, y: event.clientY };
      cancelPending();
      if (index === selected) {
        apex.current = point;
        return;
      }
      const panel = panelRef.current?.getBoundingClientRect();
      if (apex.current && panel && inSafeTriangle(apex.current, point, panel, detailsLeft)) {
        pending.current = window.setTimeout(
          () => setSelected(index),
          SAFE_TRIANGLE_DELAY_MS,
        );
        return;
      }
      setSelected(index);
    };

    // The details panel flips to the left when there is no room on the right.
    useLayoutEffect(() => {
      if (!listRef.current) return;
      const rect = listRef.current.getBoundingClientRect();
      setDetailsLeft(rect.right + DETAILS_WIDTH + 8 > window.innerWidth);
    }, [items]);

    useEffect(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (!items.length) return false;
        if (event.key === "ArrowUp") {
          setSelected((index) => (index + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelected((index) => (index + 1) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selected];
          if (!item) return true;
          // A fully typed command keeps Enter's usual meaning in a formula.
          if (
            event.key === "Enter" &&
            item.insert === `\\${query}` &&
            inMath(editor.state, range.from)
          ) {
            return false;
          }
          command(item);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) return null;
    const details = items[selected];

    return (
      <div
        className="relative"
        // Keep the editor focused while clicking items.
        onMouseDown={(event) => event.preventDefault()}
      >
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="LaTeX commands"
          onMouseMove={handlePointerMove}
          onMouseLeave={cancelPending}
          className="max-h-72 w-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md [scrollbar-width:none]"
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="option"
              id={optionId(index)}
              tabIndex={-1}
              data-index={index}
              aria-selected={index === selected}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left",
                index === selected && "bg-accent text-accent-foreground",
              )}
              onClick={() => command(item)}
            >
              <span
                aria-hidden="true"
                className="flex h-6 w-8 shrink-0 items-center justify-center overflow-hidden text-[0.7rem]"
                dangerouslySetInnerHTML={{ __html: renderIcon(item.preview) }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {item.label}
              </span>
            </button>
          ))}
        </div>
        {details ? (
          <div
            ref={panelRef}
            className={cn(
              "absolute top-0 rounded-lg bg-popover text-popover-foreground shadow-md",
              detailsLeft ? "right-full mr-1" : "left-full ml-1",
            )}
            style={{ width: DETAILS_WIDTH }}
          >
            <LatexDetails item={details} onPick={command} />
          </div>
        ) : null}
      </div>
    );
  },
);
