import { Extension } from "@tiptap/core";
import { Fragment, type Node } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { getFocusedSectionRange } from "./section-focus";

type Direction = "up" | "down";

// Swap the selected blocks with their neighbouring sibling. A block that is the
// only child of its wrapper (a paragraph in a list item) moves the wrapper.
function moveBlocks(
  state: EditorState,
  direction: Direction,
  dispatch?: (tr: Transaction) => void,
) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to);
  if (!range) return false;

  let depth = range.depth;
  let start = range.startIndex;
  let end = range.endIndex;

  for (;;) {
    const parent = $from.node(depth);
    const coversParent = start === 0 && end === parent.childCount;
    const sibling = direction === "up" ? start - 1 : end;

    if (!coversParent && sibling >= 0 && sibling < parent.childCount) {
      const moved: Node[] = [];
      for (let i = start; i < end; i++) moved.push(parent.child(i));
      const siblingNode = parent.child(sibling);
      const reordered =
        direction === "up"
          ? Fragment.from([...moved, siblingNode])
          : Fragment.from([siblingNode, ...moved]);
      const swapFrom = Math.min(start, sibling);
      const swapTo = Math.max(end, sibling + 1);

      if (parent.canReplace(swapFrom, swapTo, reordered)) {
        const parentStart = depth === 0 ? 0 : $from.start(depth);
        let blocksFrom = parentStart;
        for (let i = 0; i < start; i++) blocksFrom += parent.child(i).nodeSize;
        let blocksTo = blocksFrom;
        for (const node of moved) blocksTo += node.nodeSize;

        const siblingFrom =
          direction === "up" ? blocksFrom - siblingNode.nodeSize : blocksTo;
        const siblingTo = siblingFrom + siblingNode.nodeSize;

        // Don't move blocks into or across the parts hidden by section focus.
        const section = depth === 0 ? getFocusedSectionRange(state) : null;
        if (
          section &&
          (siblingFrom <= section.from ||
            siblingTo > section.to ||
            blocksFrom <= section.from)
        ) {
          return true;
        }

        if (dispatch) {
          // Move the neighbour rather than the selection, so the selection
          // follows its blocks through the mapping.
          const tr = state.tr.delete(siblingFrom, siblingTo);
          const insertAt =
            direction === "up" ? blocksTo - siblingNode.nodeSize : blocksFrom;
          tr.insert(insertAt, siblingNode).scrollIntoView();
          dispatch(tr);
        }
        return true;
      }
    }

    if (depth === 0) return true;
    // At the parent's edge with siblings left behind: stay put.
    if (!coversParent && (sibling < 0 || sibling >= parent.childCount)) {
      return true;
    }

    start = $from.index(depth - 1);
    end = start + 1;
    depth -= 1;
  }
}

export const MoveLines = Extension.create({
  name: "move-lines",
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": ({ editor }) =>
        moveBlocks(editor.state, "up", editor.view.dispatch),
      "Alt-ArrowDown": ({ editor }) =>
        moveBlocks(editor.state, "down", editor.view.dispatch),
    };
  },
});
