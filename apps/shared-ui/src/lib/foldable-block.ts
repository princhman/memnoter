import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { Slice } from "@tiptap/pm/model";

// A self-contained foldable block, e.g. a worked example (#27): a title line
// and content that fold on their own. A heading's fold instead runs to the
// next heading, taking the following notes with it.

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    foldableBlock: {
      // Insert an open block with an empty title and the caret in the title.
      insertFoldableBlock: () => ReturnType;
    };
  }
}

const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

// Like heading folds: open any block the caret moves into, e.g. with the arrow
// keys or a search match, so it never sits in hidden content. Yjs renders move
// the caret as a side effect, which is not the user moving it.
export function foldableBlockReveal() {
  return new Plugin({
    key: new PluginKey("foldableBlockReveal"),
    appendTransaction(transactions, oldState, newState) {
      if (
        !transactions.some(
          (tr) =>
            (tr.selectionSet || tr.docChanged) &&
            !tr.getMeta(ySyncPluginKey)?.isChangeOrigin,
        ) ||
        oldState.selection.eq(newState.selection)
      ) {
        return null;
      }
      const { $head } = newState.selection;
      let tr: Transaction | null = null;
      for (let depth = $head.depth; depth > 1; depth--) {
        if ($head.node(depth).type.name !== "detailsContent") continue;
        const details = $head.node(depth - 1);
        if (details.attrs.open) continue;
        // Changing an attribute keeps positions, so outer blocks stay valid.
        tr ??= newState.tr;
        tr.setNodeMarkup($head.before(depth - 1), undefined, { ...details.attrs, open: true });
      }
      return tr;
    },
  });
}

const FoldableDetails = Details.extend({
  addCommands() {
    return {
      ...this.parent?.(),
      insertFoldableBlock:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: this.name,
              attrs: { open: true },
              content: [
                { type: "detailsSummary" },
                { type: "detailsContent", content: [{ type: "paragraph" }] },
              ],
            })
            // insertContent leaves the caret in the content; start in the title.
            .command(({ tr }) => {
              const { $head } = tr.selection;
              for (let depth = $head.depth; depth > 0; depth--) {
                if ($head.node(depth).type.name !== this.name) continue;
                tr.setSelection(TextSelection.create(tr.doc, $head.before(depth) + 2));
                return true;
              }
              return false;
            })
            .run(),
    };
  },
  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      // Upstream inserts a new first line, which would leave the block's empty
      // line last and stop Enter there from leaving the block. Use that line.
      Enter: (props) => {
        const { $head, empty } = this.editor.state.selection;
        if (empty && $head.parent.type.name === "detailsSummary") {
          const block = $head.node(-1);
          const first = block.lastChild?.firstChild;
          if (block.attrs.open && first?.type.name === "paragraph" && first.content.size === 0) {
            return this.editor.commands.setTextSelection($head.after() + 2);
          }
        }
        return parent.Enter?.(props) ?? false;
      },
    };
  },
  // Replaces upstream's plugin, which moves the caret out of folded content.
  addProseMirrorPlugins() {
    return [foldableBlockReveal(), new Plugin({
      props: {
        transformCopied(slice, view) {
          const { selection } = view.state;
          if (!(selection instanceof TextSelection)) return slice;
          const { $from, $to } = selection;
          // Shared foldable ancestors are context, not selected blocks. PM's
          // clipboard context otherwise recreates them when this text is pasted.
          let depth = 0;
          for (let d = 1; d <= $from.sharedDepth($to.pos); d++) {
            if (["details", "detailsContent", "detailsSummary"].includes($from.node(d).type.name)) depth = d;
          }
          let { content, openStart, openEnd } = slice;
          for (let d = 0; d < depth && openStart > 0 && openEnd > 0 && content.childCount === 1; d++) {
            content = content.firstChild!.content;
            openStart--; openEnd--;
          }
          return new Slice(content, openStart, openEnd);
        },
      },
    })];
  },
}).configure({
  // Open or folded is a node attribute, so it is saved and synced with the note.
  persist: true,
  HTMLAttributes: { class: "foldable-block" },
  renderToggleButton: ({ element, isOpen }) => {
    if (!element.firstChild) {
      element.className = "foldable-block-toggle";
      element.contentEditable = "false";
      element.innerHTML = CHEVRON;
      // Keep the caret where it is; the click handler toggles the block.
      element.addEventListener("mousedown", (event) => event.preventDefault());
    }
    element.setAttribute("aria-label", isOpen ? "Fold block" : "Unfold block");
    element.setAttribute("aria-expanded", String(isOpen));
  },
});

export const FoldableBlock = [
  FoldableDetails,
  // A title can hold inline math, like any other line of the note.
  DetailsSummary.extend({ content: "inline*" }),
  // No headings: a heading inside would join the note's sections, numbering
  // and folds, which this block exists to stay out of.
  DetailsContent.extend({
    content:
      "(paragraph | mathBlock | blockquote | bulletList | orderedList | codeBlock | horizontalRule | table | image | pdfTextQuote | details)+",
  }),
];
