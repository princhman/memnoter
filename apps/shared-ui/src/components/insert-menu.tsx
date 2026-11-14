import { IMAGE_TYPES } from "@/lib/editor-schema/images";
import { surfaceClass } from "./ui/surface";
import { action, formatKeys } from "@/lib/shortcuts";
import { forwardRef, Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type RefObject } from "react";
import type { Editor, Range } from "@tiptap/core";
import { capabilities } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useActiveDescendant } from "@/hooks/use-active-descendant";

export type InsertCommandOptions = {
  // Saves picked images and inserts them at a position, as pasting does.
  insertImages: (editor: Editor, files: File[], position: number) => void;
  insertDrawing?: (editor: Editor) => void;
};

export type InsertItem = {
  group: string;
  retainSelection?: boolean;
  title: string;
  keywords: string[];
  hint: string;
  when?: (editor: Editor) => boolean;
  run: (editor: Editor, range: Range, options: InsertCommandOptions) => void;
};


function pickImages(onPick: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMAGE_TYPES.join(",");
  input.multiple = true;
  input.hidden = true;
  input.dataset.imagePicker = "";
  input.addEventListener("change", () => {
    input.remove();
    const files = Array.from(input.files ?? []).filter((file) =>
      IMAGE_TYPES.includes(file.type),
    );
    if (files.length) onPick(files);
  });
  input.addEventListener("cancel", () => input.remove());
  document.body.append(input);
  input.click();
}

// Listed in display order; a group label shows above its first item.
export const groupCardActions: InsertItem[] = (["list", "block"] as const).flatMap(kind => ([
  { group: "Flashcards", title: `Make ${kind} card`, keywords: [], hint: kind === "list" ? "Reveal one by one" : "Reveal together", retainSelection: true, when: editor => editor.can().makeGroupCard(kind), run: editor => { editor.chain().focus().makeGroupCard(kind).run(); } },
  { group: "Flashcards", title: `Remove ${kind} card`, keywords: [], hint: "Keep question and answer", retainSelection: true, when: editor => editor.can().removeGroupCard(kind), run: editor => { editor.chain().focus().removeGroupCard(kind).run(); } },
]));

const ITEMS: InsertItem[] = [
  ...(["list", "block"] as const).map((kind): InsertItem => ({
    group: "Flashcards", title: kind === "list" ? "List card" : "Block card",
    keywords: kind === "list" ? ["list card", "list flashcard", "sequential", "reveal one by one", "::list"] : ["block card", "block flashcard", "multiline", "multi line", "multi-line", "::block"],
    hint: kind === "list" ? "Reveal one by one" : "Reveal together",
    when: editor => editor.can().insertGroupCard(kind),
    run: (editor, range) => { editor.chain().focus().deleteRange(range).insertGroupCard(kind).run(); },
  })),
  {
    group: "Sections",
    title: "Insert heading above",
    keywords: ["insert title", "insert heading above", "parent", "adopt"],
    hint: "Nest the next section",
    when: editor => editor.state.selection.$from.depth === 1,
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertHeadingAbove().run(),
  },
  {
    group: "Sections",
    title: "Sibling section",
    keywords: ["section", "same", "next", "heading"],
    hint: formatKeys(action("section.sibling").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertSection("sibling").run(),
  },
  {
    group: "Sections",
    title: "Subsection",
    keywords: ["section", "child", "nested", "deeper", "heading"],
    hint: formatKeys(action("section.child").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertSection("subsection").run(),
  },
  ...[1, 2, 3, 4, 5, 6].map(
    (level): InsertItem => ({
      group: "Headings",
      title: `Heading ${level}`,
      keywords: [`h${level}`, "heading", "title"],
      hint: formatKeys(action(`heading.${level}`).keys),
      run: (editor, range) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level })
          .run(),
    }),
  ),
  {
    group: "Blocks",
    title: "Table",
    keywords: ["table", "grid", "cells"],
    hint: "3 × 3",
    when: (editor) => !editor.isActive("table"),
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    group: "Blocks",
    title: "Bullet list",
    keywords: ["list", "bullet", "unordered", "ul", "-"],
    hint: formatKeys(action("list.bullet").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    group: "Blocks",
    title: "Numbered list",
    keywords: ["list", "numbered", "ordered", "ol", "1."],
    hint: formatKeys(action("list.ordered").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    group: "Blocks",
    title: "Code block",
    keywords: ["code", "pre", "snippet", "```"],
    hint: formatKeys(action("block.code").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    group: "Blocks",
    title: "Mermaid diagram",
    keywords: ["mermaid", "diagram", "flowchart", "chart", "graph", "sequence"],
    hint: "",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setCodeBlock({ language: "mermaid" }).run(),
  },
  {
    group: "Blocks",
    title: "Quote",
    keywords: ["quote", "blockquote", "citation", ">"],
    hint: formatKeys(action("block.quote").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    group: "Blocks", title: "Drawing", keywords: ["drawing", "draw", "ink", "pen", "sketch"], hint: "",
    when: () => capabilities.macDrawing,
    run: (editor, range, options) => { editor.chain().deleteRange(range).run(); options.insertDrawing?.(editor); },
  },
  {
    group: "Blocks",
    title: "Foldable block",
    keywords: ["fold", "foldable", "toggle", "example", "collapse", "details", ">>>"],
    hint: formatKeys(action("block.foldable").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertFoldableBlock().run(),
  },
  {
    group: "Blocks",
    title: "Image",
    keywords: ["image", "picture", "photo", "upload", "file"],
    hint: "",
    run: (editor, range, options) => {
      editor.chain().focus().deleteRange(range).run();
      pickImages((files) =>
        options.insertImages(editor, files, editor.state.selection.from),
      );
    },
  },
  {
    group: "Math",
    title: "Inline math",
    keywords: ["math", "equation", "latex", "formula", "$"],
    hint: formatKeys(action("math.inline").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleInlineMath().run(),
  },
  {
    group: "Math",
    title: "Math block",
    keywords: ["math", "equation", "latex", "formula", "$$"],
    hint: formatKeys(action("math.block").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleMathBlock().run(),
  },
  ...([
    ["Add row above", "addRowBefore"], ["Add row below", "addRowAfter"],
    ["Add column left", "addColumnBefore"], ["Add column right", "addColumnAfter"],
    ["Delete row", "deleteRow"], ["Delete column", "deleteColumn"],
    ["Toggle header row", "toggleHeaderRow"], ["Delete table", "deleteTable"],
  ] as const).map(([title, command]): InsertItem => ({
    group: "Table", title, keywords: ["table", ...title.toLowerCase().split(" ")], hint: "",
    when: (editor) => editor.isActive("table"),
    run: (editor, range) => editor.chain().focus().deleteRange(range)[command]().run(),
  })),
];

export function filterItems(query: string, editor: Editor) {
  const q = query.toLowerCase().trim();
  return ITEMS.filter(item => !item.when || item.when(editor)).filter(
    (item) =>
      !q || item.title.toLowerCase().includes(q) ||
      item.keywords.some((keyword) => keyword.startsWith(q)),
  );
}

export type InsertMenuProps = {
  embedded?: boolean;
  focusTarget?: RefObject<HTMLElement | null>;
  items: InsertItem[];
  command: (item: InsertItem) => void;
  editor: Editor;
};
export type InsertMenuHandle = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

export const InsertMenu = forwardRef<InsertMenuHandle, InsertMenuProps>(
  ({ items, command, editor, embedded = false, focusTarget }, ref) => {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const listboxId = useId();
    const optionId = (index: number) => `${listboxId}-${index}`;
    useActiveDescendant(editor, listboxId, items.length ? optionId(selected) : null, focusTarget);

    useEffect(() => setSelected(0), [items]);

    useEffect(() => {
      const list = listRef.current;
      const option = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
      if (!list || !option) return;
      const bounds = list.getBoundingClientRect();
      const row = option.getBoundingClientRect();
      if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
      else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
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
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) return null;

    return (
      <div
        className={cn(!embedded && surfaceClass, "w-56 py-1 pl-1", embedded && "flex min-h-0 flex-col")}
        // Keep the editor focused while clicking items.
        onMouseDown={(event) => event.preventDefault()}
      >
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Insert"
          // A stable gutter keeps the rows the same width whether or not
          // filtering leaves enough items to scroll.
          className="min-h-0 max-h-72 overflow-y-auto pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]"
        >
        {items.map((item, index) => (
          <Fragment key={item.title}>
            {item.group !== items[index - 1]?.group && (
              // Each option's name says what it is; the label is visual only.
              <div
                aria-hidden="true"
                className={cn(
                  "px-2 pb-0.5 text-xs text-muted-foreground",
                  index === 0 ? "pt-1" : "mt-1 border-t pt-1.5",
                )}
              >
                {item.group}
              </div>
            )}
            <button
              type="button"
              role="option"
              id={optionId(index)}
              tabIndex={-1}
              data-index={index}
              aria-selected={index === selected}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-sm",
                index === selected && "bg-accent text-accent-foreground",
              )}
              onMouseEnter={() => setSelected(index)}
              onClick={() => command(item)}
            >
              <span className="truncate">{item.title}</span>
              {item.hint && (
                <kbd className="shrink-0 font-sans text-xs text-muted-foreground">
                  {item.hint}
                </kbd>
              )}
            </button>
          </Fragment>
        ))}
        </div>
      </div>
    );
  },
);
