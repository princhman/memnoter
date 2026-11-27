import { changedRanges, isImageNode } from "../cards.ts";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { NodeType } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { changesOutsideSection, getFocusedSectionRange } from "../section-focus";

export function addLineAfterPastedImage(tr: Transaction, sectionEnd?: number) {
  const image = tr.doc.type.schema.nodes.image;
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  let imageEnd = -1;
  for (const { from, to } of changedRanges(tr.mapping.maps)) {
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === image && pos >= from && pos + node.nodeSize <= to) {
        imageEnd = Math.max(imageEnd, pos + node.nodeSize);
      }
    });
  }
  if (imageEnd < 0) return false;
  const after = tr.doc.resolve(imageEnd);
  const atSectionEnd = after.depth === 0 && sectionEnd !== undefined &&
    imageEnd === tr.mapping.map(sectionEnd, 1);
  if (after.nodeAfter && !atSectionEnd) return false;
  if (!after.parent.canReplaceWith(after.index(), after.index(), paragraph)) return false;
  tr.insert(imageEnd, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, imageEnd + 1)).scrollIntoView();
  return true;
}

// Puts the cursor in the text flowing beside a wrapped image: at the end of
// the last text block that starts above the click, or in a new paragraph when
// nothing follows the image yet.
function placeCursorBeside(view: EditorView, imagePos: number, imageSize: number, y: number) {
  const after = imagePos + imageSize;
  const $after = view.state.doc.resolve(after);
  const parent = $after.parent;
  let target: number | null = null;
  let offset = after;
  for (let index = $after.index(); index < parent.childCount; index++) {
    const child = parent.child(index);
    if (!child.isTextblock) break;
    const dom = view.nodeDOM(offset);
    // The first block starts level with the image, so it always qualifies.
    if (target !== null && (!(dom instanceof HTMLElement) || dom.getBoundingClientRect().top > y)) break;
    target = offset + child.nodeSize - 1;
    offset += child.nodeSize;
  }
  const tr = view.state.tr;
  if (target === null) {
    tr.insert(after, view.state.schema.nodes.paragraph.create());
    target = after + 1;
  }
  tr.setSelection(TextSelection.create(tr.doc, target));
  view.dispatch(tr);
  view.focus();
}

// Typing replaces a selected node, so a selected image would be overwritten.
// Send the text where it reads next to the image instead.
function typeBesideImage(view: EditorView, selection: NodeSelection, text: string) {
  const { node, from } = selection;
  const after = from + node.nodeSize;
  if (node.type.isInline) {
    const tr = view.state.tr.insertText(text, after);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + text.length)));
    return;
  }
  if (node.attrs.wrap) {
    const block = (view.nodeDOM(from) as HTMLElement | null)?.querySelector(".note-image-block");
    placeCursorBeside(view, from, node.nodeSize, block?.getBoundingClientRect().bottom ?? 0);
    view.dispatch(view.state.tr.insertText(text));
    return;
  }
  // Text below an image on its own line starts a new line of its own.
  const tr = view.state.tr.insert(after, view.state.schema.nodes.paragraph.create(null, view.state.schema.text(text)));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1 + text.length)));
}

// Handles typing on a selected image, and clicks in the blank space beside a
// floated image, which belongs to no text block: the browser would resolve
// those clicks into the image itself.
export function imageTextPlugin(type: NodeType) {
  return new Plugin({
    key: new PluginKey("image-text"),
    props: {
      handlePaste(view, event, slice) {
        if (event.clipboardData?.files.length || !slice.content.childCount ||
            !slice.content.content.every(node => node.type === type)) return false;
        const range = getFocusedSectionRange(view.state);
        const tr = view.state.tr.replaceSelection(slice);
        if (!addLineAfterPastedImage(tr, range?.to)) return false;
        if (range && changesOutsideSection(tr, range)) return false;
        view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
        return true;
      },
      handleTextInput(view, _from, _to, text) {
        const { selection } = view.state;
        if (!(selection instanceof NodeSelection) || !isImageNode(selection.node)) return false;
        typeBesideImage(view, selection, text);
        return true;
      },
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0 || event.target !== view.dom || !view.editable) return false;
          let handled = false;
          view.state.doc.descendants((node, pos) => {
            if (handled) return false;
            if (node.type !== type || !node.attrs.wrap) return;
            const dom = view.nodeDOM(pos);
            const block = dom instanceof HTMLElement ? dom.querySelector(".note-image-block") ?? dom : null;
            if (!block) return false;
            const box = block.getBoundingClientRect();
            if (event.clientY < box.top || event.clientY > box.bottom) return false;
            const textSide = node.attrs.alignment === "right" ? event.clientX < box.left : event.clientX > box.right;
            if (!textSide) return false;
            placeCursorBeside(view, pos, node.nodeSize, event.clientY);
            handled = true;
            return false;
          });
          if (handled) event.preventDefault();
          return handled;
        },
      },
    },
  });
}

