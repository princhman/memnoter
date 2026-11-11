import { parseCardId } from "./card-id";
import { clozeIdsOf } from "./cards";
import { editorHost } from "@/lib/editor-host";
import type { Editor } from "@tiptap/core";
import { createStore, useSelector } from "@tanstack/react-store";
import { useEffect } from "react";
import { stopScrollRestore } from "@/lib/view-persistence";

// A request to show a card's text in its note, from review's go-to action. It
// waits until that note is open and has restored its view, then puts the
// selection on its cloze or image, or caret in its block. Not persisted.
export type CardRevealRequest = { moduleId: string; cardId: string };

const cardRevealStore = createStore<CardRevealRequest | null>(null);

export function requestCardReveal(request: CardRevealRequest) {
  cardRevealStore.setState(() => request);
}

export function useCardReveal(editor: Editor | null, moduleId: string, ready: boolean) {
  const request = useSelector(cardRevealStore, (state) => state);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !ready || request?.moduleId !== moduleId) return;
    const card = parseCardId(request.cardId);
    let start: number | null = null;
    let end: number | null = null;
    let blockPosition = 0;
    let image = false;
    editor.state.doc.descendants((node, pos) => {
      if (start !== null) return false;
      if (card.kind === "occlusion" && node.attrs.imageId === card.blockId) {
        start = pos;
        blockPosition = pos;
        image = true;
        return false;
      }
      if (!node.isTextblock) return true;
      if (node.attrs.cardId === card.blockId) {
        blockPosition = pos;
        start = pos + 1;
        if (card.kind === "cloze") {
          const cloze = clozeIdsOf(node).find(entry => entry.id === card.clozeId);
          if (cloze) { start += cloze.from; end = pos + 1 + cloze.to; }
        }
      }
      return false;
    });
    if (start === null) return;
    cardRevealStore.setState(() => null);

    // The saved scroll position would otherwise pull the view back.
    stopScrollRestore();
    // Section focus can hide the target even after its caret moves there.
    // Clear that filter; the caret also unfolds any folded ancestor.
    const chain = editor.chain().showDocument();
    if (image) chain.setNodeSelection(start).run();
    else chain.setTextSelection({ from: start, to: end ?? start }).run();
    editor.view.focus();

    // Align the source block instead of only revealing the caret's nearest edge.
    const position = blockPosition;
    {
      if (editor.isDestroyed || !editor.view.dom.isConnected) return;
      const container = editorHost.scrollContainer(editor.view.dom);
      const block = editor.view.nodeDOM(position);
      if (!container || !(block instanceof HTMLElement)) return;
      const top = container.getBoundingClientRect().top + container.clientTop;
      container.scrollTop += block.getBoundingClientRect().top - top
        - Math.min(96, container.clientHeight / 4);
    }
  }, [editor, moduleId, ready, request]);
}
