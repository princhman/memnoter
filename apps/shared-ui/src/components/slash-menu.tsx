import { action, formatKeys } from "@/lib/shortcuts";
import {
  forwardRef,
  Fragment,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { cn } from "@/lib/utils";
import { useActiveDescendant } from "@/hooks/use-active-descendant";

export type SlashCommandOptions = {
  // Saves picked images and inserts them at a position, as pasting does.
  insertImages: (editor: Editor, files: File[], position: number) => void;
};

type SlashItem = {
  group: string;
  title: string;
  keywords: string[];
  hint: string;
  when?: (editor: Editor) => boolean;
  run: (editor: Editor, range: Range, options: SlashCommandOptions) => void;
};


import { IMAGE_TYPES } from "@/lib/editor-schema/images";

function pickImages(onPick: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMAGE_TYPES.join(",");
  input.multiple = true;
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []).filter((file) =>
      IMAGE_TYPES.includes(file.type),
    );
    if (files.length) onPick(files);
  });
  input.click();
}

// Listed in display order; a group label shows above its first item.
const ITEMS: SlashItem[] = [
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
    (level): SlashItem => ({
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
    title: "Quote",
    keywords: ["quote", "blockquote", "citation", ">"],
    hint: formatKeys(action("block.quote").keys),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
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
  ] as const).map(([title, command]): SlashItem => ({
    group: "Table", title, keywords: ["table", ...title.toLowerCase().split(" ")], hint: "",
    when: (editor) => editor.isActive("table"),
    run: (editor, range) => editor.chain().focus().deleteRange(range)[command]().run(),
  })),
];

function filterItems(query: string, editor: Editor) {
  const q = query.toLowerCase().trim();
  return ITEMS.filter(item => !item.when || item.when(editor)).filter(
    (item) =>
      !q || item.title.toLowerCase().includes(q) ||
      item.keywords.some((keyword) => keyword.startsWith(q)),
  );
}

// Typing  /  in raw text such as formulas or code is literal.
const RAW_TEXT_NODES = new Set(["codeBlock", "mathBlock", "inlineMath"]);

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slash-command",
  // Arrow keys and Enter go to the open menu before other extensions.
  priority: 200,

  addOptions() {
    return { insertImages: () => {} };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slash-command"),
        char: "/",
        items: ({ query, editor }) => filterItems(query, editor),
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          for (let depth = $from.depth; depth > 0; depth--) {
            if (RAW_TEXT_NODES.has($from.node(depth).type.name)) return false;
          }
          return true;
        },
        command: ({ editor, range, props }) => props.run(editor, range, options),
        render: () => {
          let renderer: ReactRenderer<SlashMenuHandle, SlashMenuProps> | null =
            null;
          let unmount: (() => void) | null = null;

          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SlashMenu, {
                props,
                editor: props.editor,
                // The wrapper is what gets positioned, so it carries the layer.
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

type SlashMenuProps = SuggestionProps<SlashItem, SlashItem>;
type SlashMenuHandle = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(
  ({ items, command, editor }, ref) => {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const listboxId = useId();
    const optionId = (index: number) => `${listboxId}-${index}`;
    useActiveDescendant(editor, listboxId, items.length ? optionId(selected) : null);

    useEffect(() => setSelected(0), [items]);

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
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) return null;

    return (
      <div
        className="w-56 rounded-lg floating-surface bg-popover py-1 pl-1 text-popover-foreground shadow-md"
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
          className="max-h-72 overflow-y-auto pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]"
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
