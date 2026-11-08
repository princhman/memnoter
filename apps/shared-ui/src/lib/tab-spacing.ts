import { Extension } from "@tiptap/core";
import type { Command } from "@tiptap/pm/state";

// Runs after suggestion, math and list keymaps. Always consumes Tab so it
// cannot move focus away from an editable note, even at a list boundary.
function tabSpacing(outdent = false): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    if ($from.parent.type.spec.code && $from.sameParent($to)) {
      const start = $from.start();
      const text = $from.parent.textContent;
      const first = text.lastIndexOf("\n", $from.parentOffset - 1) + 1;
      const last = $to.parentOffset;
      const lines = [first];
      for (let i = first; i < last; i++) {
        if (text[i] === "\n" && i + 1 < last) lines.push(i + 1);
      }
      const tr = state.tr;
      if (!outdent && state.selection.empty) tr.insertText("  ");
      else for (const offset of lines.reverse()) {
        if (outdent) {
          const count = text.slice(offset).match(/^ {0,2}/)![0].length;
          if (count) tr.delete(start + offset, start + offset + count);
        } else tr.insertText("  ", start + offset);
      }
      if (dispatch && tr.docChanged) dispatch(tr);
    } else if (!outdent && $from.parent.inlineContent) {
      dispatch?.(state.tr.insertText("\t"));
    }
    return true;
  };
}

export const TabSpacing = Extension.create({
  name: "tabSpacing",
  priority: 50,
  addKeyboardShortcuts() {
    return {
      Tab: () => tabSpacing()(this.editor.state, this.editor.view.dispatch),
      "Shift-Tab": () => tabSpacing(true)(this.editor.state, this.editor.view.dispatch),
    };
  },
});
