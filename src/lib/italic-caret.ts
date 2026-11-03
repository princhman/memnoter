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

// WebKit draws the native caret as tall as the whole line, so beside a tall
// inline image it spans the image. Those lines get a drawn, text-height caret.
function besideInlineImage(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return false;
  let found = false;
  selection.$from.parent.forEach((node) => {
    if (node.type.name === "inlineImage") found = true;
  });
  return found;
}

// Browsers always draw the native caret upright, so while typing in italic the
// native caret is hidden and a slanted one is drawn at the cursor instead.
// The same drawn caret, upright, replaces the native one beside inline images.
export const ItalicCaret = Extension.create({
  name: "italic-caret",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: italicCaretKey,
        props: {
          attributes: (state): Record<string, string> =>
            italicMarksAtCursor(state) || besideInlineImage(state) ? { class: "italic-caret-active" } : {},
          decorations(state) {
            const italic = italicMarksAtCursor(state);
            if (!italic && !besideInlineImage(state)) return null;
            const marks = italic ?? state.storedMarks ?? state.selection.$from.marks();

            const { head } = state.selection;
            const caret = Decoration.widget(
              head,
              () => {
                const element = document.createElement("span");
                element.className = italic ? "italic-caret" : "italic-caret is-upright";
                element.setAttribute("aria-hidden", "true");
                return element;
              },
              {
                // A new key per position remakes the element, restarting the blink.
                key: `italic-caret-${head}-${italic ? "slanted" : "upright"}`,
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
