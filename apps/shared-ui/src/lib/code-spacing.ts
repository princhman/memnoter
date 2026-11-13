import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

// macOS can replace the spaces with ". " before ProseMirror sees text input.
// Own space insertion in code, and reject that specific native replacement.
export const CodeSpacing = Extension.create({
  name: "codeSpacing",
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleDOMEvents: {
          beforeinput(view, event) {
            const input = event as InputEvent;
            if (!input.cancelable || input.isComposing || view.composing || !view.editable) return false;
            const space = input.inputType === "insertText" && input.data === " ";
            const replacement = (input.inputType === "insertReplacementText" || input.inputType === "insertText") && input.data === ". ";
            if (!space && !replacement) return false;

            let { from, to } = view.state.selection;
            const ranges = input.getTargetRanges?.() ?? [];
            if (ranges.length > 1) return false;
            if (ranges.length) {
              const range = ranges[0];
              if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer)) return false;
              from = view.posAtDOM(range.startContainer, range.startOffset);
              to = view.posAtDOM(range.endContainer, range.endOffset);
            } else if (replacement) {
              // Without an explicit replacement range a literal period is ambiguous.
              return false;
            }
            const { doc, storedMarks } = view.state;
            const $from = doc.resolve(from), $to = doc.resolve(to);
            if (!$from.sameParent($to)) return false;
            const code = view.state.schema.marks.code;
            let markedCode = !!code && from < to;
            if (markedCode) doc.nodesBetween(from, to, node => {
              if (node.isText && !code.isInSet(node.marks)) markedCode = false;
            });
            const inCode = $from.parent.type.spec.code || (code && (
              from === to
                ? code.isInSet(storedMarks ?? $from.marks())
                : markedCode
            ));
            if (!inCode) return false;
            if (replacement && !/^ {1,2}$/.test(doc.textBetween(from, to))) return false;

            input.preventDefault();
            view.dispatch(view.state.tr.insertText(space ? " " : "  ", from, to));
            return true;
          },
        },
      },
    })];
  },
});
