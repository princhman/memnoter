import Highlight, { inputRegex, pasteRegex } from "@tiptap/extension-highlight";
import { markInputRule, markPasteRule } from "@tiptap/core";

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type HighlightColor = typeof HIGHLIGHT_COLORS[number];
export function highlightColor(value: unknown): HighlightColor {
  return HIGHLIGHT_COLORS.includes(value as HighlightColor) ? value as HighlightColor : "yellow";
}

// Keep the official mark, commands and syntax, but persist semantic tokens and
// never import arbitrary pasted CSS into the shared document.
export const NoteHighlight = Highlight.extend({
  addStorage() { return { lastColor: "yellow" as HighlightColor }; },
  addAttributes() {
    return {
      color: {
        default: "yellow",
        parseHTML: (element: HTMLElement) => highlightColor(element.getAttribute("data-color")),
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-color": highlightColor(attributes.color),
          class: "note-highlight",
        }),
      },
    };
  },
  addCommands() {
    const color = (value?: string) => {
      if (value !== undefined) this.storage.lastColor = highlightColor(value);
      return this.storage.lastColor;
    };
    return {
      ...this.parent?.(),
      setHighlight: attributes => ({ commands }) => commands.setMark(this.name, { color: color(attributes?.color) }),
      toggleHighlight: attributes => ({ commands }) => commands.toggleMark(this.name, { color: color(attributes?.color) }),
    };
  },
  addInputRules() {
    return [markInputRule({ find: inputRegex, type: this.type, getAttributes: () => ({ color: this.storage.lastColor }) })];
  },
  addPasteRules() {
    return [markPasteRule({ find: pasteRegex, type: this.type, getAttributes: () => ({ color: this.storage.lastColor }) })];
  },
}).configure({ multicolor: true });
