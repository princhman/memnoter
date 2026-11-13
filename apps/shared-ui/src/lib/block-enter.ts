import { Extension } from "@tiptap/core";
import { canSplit } from "@tiptap/pm/transform";
import { TextSelection } from "@tiptap/pm/state";

const blocks = new Set(["codeBlock", "mathBlock", "blockquote", "details", "bulletList", "orderedList"]);

export const BlockEnter = Extension.create({
  name: "blockEnter",
  // Own these keys before node keymaps, including Details' title handling.
  priority: 1100,
  addKeyboardShortcuts() {
    const blockDepth = () => {
      const { $head } = this.editor.state.selection;
      for (let depth = $head.depth; depth > 0; depth--) {
        if (blocks.has($head.node(depth).type.name)) return depth;
      }
      return 0;
    };

    const leave = (depth: number, trimEmptyLine = false) => {
      const { state, view } = this.editor;
      const { $head } = state.selection;
      const tr = state.tr;
      const after = $head.after(depth);
      if (trimEmptyLine) {
        if ($head.parent.type.spec.code || $head.parent.lastChild?.type.name === "hardBreak") {
          if ($head.parent.content.size) tr.delete($head.pos - 1, $head.pos);
          else tr.delete($head.before(depth), after);
        } else {
          // Remove the empty paragraph, or its now-empty list item/wrapper.
          let removeDepth = $head.depth;
          while (removeDepth > depth && $head.node(removeDepth - 1).childCount === 1) removeDepth--;
          const node = $head.node(removeDepth);
          const parent = $head.node(removeDepth - 1);
          const index = $head.index(removeDepth - 1);
          if (parent.canReplace(index, index + 1)) {
            tr.delete($head.before(removeDepth), $head.after(removeDepth));
          } else if (node.type.name !== "detailsContent") {
            return false;
          }
          // Details requires a body paragraph even when its last line is empty.
        }
      }
      const pos = tr.mapping.map(after);
      const paragraph = state.schema.nodes.paragraph;
      const $pos = tr.doc.resolve(pos);
      if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), paragraph)) return false;
      tr.insert(pos, paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      view.dispatch(tr.scrollIntoView());
      return true;
    };

    return {
      "Mod-Enter": () => {
        const depth = blockDepth();
        return depth ? leave(depth) : false;
      },
      "Shift-Enter": () => {
        if (!blockDepth()) return false;
        if (this.editor.state.selection.$head.parent.type.spec.code) {
          const { state, view } = this.editor;
          view.dispatch(state.tr.insertText("\n").scrollIntoView());
          return true;
        }
        const { state, view } = this.editor;
        view.dispatch(state.tr.replaceSelectionWith(state.schema.nodes.hardBreak.create(), true).scrollIntoView());
        return true;
      },
      Enter: () => {
        const depth = blockDepth();
        if (!depth) return false;
        const { selection } = this.editor.state;
        const { $head } = selection;
        const parent = $head.parent;
        // Inline formulas own Enter to finish editing their source.
        if (parent.type.name === "inlineMath") return false;
        const atEnd = $head.parentOffset === parent.content.size;
        const emptyLine = parent.content.size === 0 ||
          (parent.type.spec.code && parent.textContent.endsWith("\n")) ||
          parent.lastChild?.type.name === "hardBreak";
        let last = true;
        for (let d = $head.depth; d > depth; d--) {
          if ($head.index(d - 1) !== $head.node(d - 1).childCount - 1) last = false;
        }
        if (selection.empty && atEnd && emptyLine && last) return leave(depth, true);
        if (parent.type.spec.code) return this.editor.commands.newlineInCode();
        if (parent.type.name === "detailsSummary") {
          // A title is a single textblock: Enter continues in the body.
          const pos = $head.after() + 1;
          const tr = this.editor.state.tr;
          const content = tr.doc.nodeAt(pos - 1);
          if (!content) return false;
          if (content.firstChild?.type.name !== "paragraph" || content.firstChild.content.size) {
            tr.insert(pos, this.editor.schema.nodes.paragraph.create());
          }
          tr.setNodeMarkup($head.before(depth), undefined, { ...$head.node(depth).attrs, open: true });
          tr.setSelection(TextSelection.create(tr.doc, pos + 1));
          this.editor.view.dispatch(tr.scrollIntoView());
          return true;
        }
        // Upstream refuses to split an empty item and falls back to a
        // paragraph inside that item. A non-final empty item still needs a sibling.
        if (parent.content.size === 0 && $head.node(-1).type.name === "listItem" &&
          canSplit(this.editor.state.doc, $head.pos, 2)) {
          this.editor.view.dispatch(this.editor.state.tr.split($head.pos, 2).scrollIntoView());
          return true;
        }
        return this.editor.commands.first(({ commands }) => [
          () => commands.splitListItem("listItem"),
          () => commands.splitBlock(),
        ]);
      },
    };
  },
});
