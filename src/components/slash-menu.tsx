import {
  forwardRef,
  Fragment,
  useEffect,
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
import { cn, MOD_KEY } from "@/lib/utils";

type SlashItem = {
  group: string;
  title: string;
  keywords: string[];
  hint: string;
  run: (editor: Editor, range: Range) => void;
};

const ALT_KEY = MOD_KEY === "⌘" ? "⌥" : "Alt+";
const shortcut = (key: string) => `${MOD_KEY}${ALT_KEY}${key}`;

// Listed in display order; a group label shows above its first item.
const ITEMS: SlashItem[] = [
  {
    group: "Sections",
    title: "Sibling section",
    keywords: ["section", "same", "next", "heading"],
    hint: shortcut("S"),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertSection("sibling").run(),
  },
  {
    group: "Sections",
    title: "Subsection",
    keywords: ["section", "child", "nested", "deeper", "heading"],
    hint: shortcut("D"),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertSection("subsection").run(),
  },
  ...[1, 2, 3, 4, 5, 6].map(
    (level): SlashItem => ({
      group: "Headings",
      title: `Heading ${level}`,
      keywords: [`h${level}`, "heading", "title"],
      hint: shortcut(String(level)),
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
    group: "Math",
    title: "Inline math",
    keywords: ["math", "equation", "latex", "formula", "$"],
    hint: `${MOD_KEY}${MOD_KEY === "⌘" ? "⇧" : "Shift+"}M`,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleInlineMath().run(),
  },
  {
    group: "Math",
    title: "Math block",
    keywords: ["math", "equation", "latex", "formula", "$$"],
    hint: shortcut("M"),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleMathBlock().run(),
  },
];

function filterItems(query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return ITEMS;
  return ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.keywords.some((keyword) => keyword.startsWith(q)),
  );
}

// Typing  /  in raw text such as formulas or code is literal.
const RAW_TEXT_NODES = new Set(["codeBlock", "mathBlock", "inlineMath"]);

export const SlashCommand = Extension.create({
  name: "slash-command",
  // Arrow keys and Enter go to the open menu before other extensions.
  priority: 200,

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slash-command"),
        char: "/",
        items: ({ query }) => filterItems(query),
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          for (let depth = $from.depth; depth > 0; depth--) {
            if (RAW_TEXT_NODES.has($from.node(depth).type.name)) return false;
          }
          return true;
        },
        command: ({ editor, range, props }) => props.run(editor, range),
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
  ({ items, command }, ref) => {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

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
        className="w-56 rounded-lg bg-popover py-1 pl-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        // Keep the editor focused while clicking items.
        onMouseDown={(event) => event.preventDefault()}
      >
        <div
          ref={listRef}
          role="listbox"
          // A stable gutter keeps the rows the same width whether or not
          // filtering leaves enough items to scroll.
          className="max-h-72 overflow-y-auto pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]"
        >
        {items.map((item, index) => (
          <Fragment key={item.title}>
            {item.group !== items[index - 1]?.group && (
              <div
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
              <kbd className="shrink-0 font-sans text-xs text-muted-foreground">
                {item.hint}
              </kbd>
            </button>
          </Fragment>
        ))}
        </div>
      </div>
    );
  },
);
