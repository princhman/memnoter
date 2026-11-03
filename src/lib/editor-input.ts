import { NodeSelection, type Selection } from "@tiptap/pm/state";

// Atom widgets have no caret to type into. Keep text input available for real
// text selections, including the editable source inside math nodes.
export function suppressesTextInput(selection: Selection): boolean {
  return selection instanceof NodeSelection && selection.node.isAtom && !selection.node.isText;
}
