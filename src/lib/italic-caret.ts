import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const italicCaretKey = new PluginKey("italic-caret");

function italicMarksAtCursor(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const marks = state.storedMarks ?? selection.$from.marks();
  return marks.some((mark) => mark.type.name === "italic") ? marks : null;
}

// Browsers always draw the native caret upright, so while typing in italic the
// native caret is hidden and a slanted one is drawn at the cursor instead.
export const ItalicCaret = Extension.create({
  name: "italic-caret",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: italicCaretKey,
        props: {
          attributes: (state): Record<string, string> =>
            italicMarksAtCursor(state) ? { class: "italic-caret-active" } : {},
          decorations(state) {
            const marks = italicMarksAtCursor(state);
            if (!marks) return null;

            const { head } = state.selection;
            const caret = Decoration.widget(
              head,
              () => {
                const element = document.createElement("span");
                element.className = "italic-caret";
                element.setAttribute("aria-hidden", "true");
                return element;
              },
              {
                // A new key per position remakes the element, restarting the blink.
                key: `italic-caret-${head}`,
                side: -1,
                // Wrap in the cursor's marks so the italic text isn't split around it.
                marks,
                ignoreSelection: true,
              },
            );
            return DecorationSet.create(state.doc, [caret]);
          },
        },
      }),
    ];
  },
});
