import { IS_APPLE } from "./platform.ts";

export type ShortcutAction = {
  id: string;
  title: string;
  keys: string;
  menuId?: string;
  run?: () => void | Promise<void>;
};

// TipTap key notation is also the source for hints and native accelerators.
export const SHORTCUTS: readonly ShortcutAction[] = [
  { id: "settings.open", title: "Settings", keys: "Mod-,", menuId: "settings" },
  { id: "module.new", title: "New module", keys: "Mod-n", menuId: "new-module" },
  { id: "module.import", title: "Import Folder…", keys: "", menuId: "import-folder" },
  { id: "find.open", title: "Find in note", keys: "Mod-f", menuId: "find" },
  { id: "sidebar.toggle", title: "Toggle sidebar", keys: "Mod-d", menuId: "toggle-sidebar" },
  { id: "history.undo", title: "Undo", keys: "Mod-z", menuId: "editor-undo" },
  { id: "history.redo", title: "Redo", keys: "Mod-Shift-z", menuId: "editor-redo" },
  { id: "palette.open", title: "Search modules and commands", keys: "Mod-k" },
  { id: "section.sibling", title: "New section", keys: "Mod-Alt-s" },
  { id: "section.child", title: "Subsection", keys: "Mod-Alt-d" },
  { id: "section.fold", title: "Fold section", keys: "Mod-Alt-[" },
  { id: "section.unfold", title: "Unfold section", keys: "Mod-Alt-]" },
  { id: "math.inline", title: "Inline math", keys: "Mod-Shift-m" },
  { id: "math.block", title: "Math block", keys: "Mod-Alt-m" },
  { id: "link.edit", title: "Add a link", keys: "Mod-l" },
  { id: "link.open", title: "Open link", keys: "Mod-click" },
  { id: "text.bold", title: "Bold", keys: "Mod-b" },
  { id: "text.italic", title: "Italic", keys: "Mod-i" },
  { id: "text.underline", title: "Underline", keys: "Mod-u" },
  { id: "text.strike", title: "Strikethrough", keys: "Mod-Shift-s" },
  { id: "text.code", title: "Code", keys: "Mod-e" },
  { id: "text.highlight", title: "Highlight", keys: "Mod-Shift-h" },
  { id: "card.cloze", title: "Cloze", keys: "Mod-Shift-c" },
  { id: "list.bullet", title: "Bullet list", keys: "Mod-Shift-8" },
  { id: "list.ordered", title: "Numbered list", keys: "Mod-Shift-7" },
  { id: "block.code", title: "Code block", keys: "Mod-Alt-c" },
  { id: "block.quote", title: "Quote", keys: "Mod-Shift-b" },
  { id: "find.replace", title: "Find and replace", keys: "Mod-Alt-f" },
  { id: "find.next", title: "Next match", keys: "Mod-g" },
  { id: "find.previous", title: "Previous match", keys: "Mod-Shift-g" },
  { id: "block.insert", title: "Insert a block", keys: "/" },
  { id: "heading.1", title: "Heading 1", keys: "Mod-Alt-1" },
  { id: "heading.2", title: "Heading 2", keys: "Mod-Alt-2" },
  { id: "heading.3", title: "Heading 3", keys: "Mod-Alt-3" },
  { id: "heading.4", title: "Heading 4", keys: "Mod-Alt-4" },
  { id: "heading.5", title: "Heading 5", keys: "Mod-Alt-5" },
  { id: "heading.6", title: "Heading 6", keys: "Mod-Alt-6" },
];

export function action(id: string): ShortcutAction {
  const entry = SHORTCUTS.find((entry) => entry.id === id);
  if (!entry) throw new Error(`Unknown shortcut action: ${id}`);
  return entry;
}

export function formatKeys(keys: string, apple = IS_APPLE): string {
  const names: Record<string, string> = apple
    ? { Mod: "⌘", Alt: "⌥", Shift: "⇧", Control: "⌃", Enter: "↵", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }
    : { Mod: "Ctrl", Alt: "Alt", Shift: "Shift", Control: "Ctrl" };
  return keys.split("-").map((key) => names[key] ?? (key.length === 1 ? key.toUpperCase() : key)).join(apple ? "" : "+");
}

export function matchesShortcut(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.split("-");
  const key = parts.pop()!;
  return (event.metaKey || event.ctrlKey) === parts.includes("Mod") &&
    event.altKey === parts.includes("Alt") && event.shiftKey === parts.includes("Shift") &&
    (event.key.toLowerCase() === key.toLowerCase() || event.code === `Key${key.toUpperCase()}`);
}

export function bindsInJS(entry: ShortcutAction, nativeMenu: boolean): boolean {
  return !nativeMenu || !entry.menuId;
}
