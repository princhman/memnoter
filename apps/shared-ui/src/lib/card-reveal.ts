import type { Editor } from "@tiptap/core";
import { createStore, useSelector } from "@tanstack/react-store";
import { useEffect } from "react";
import { stopScrollRestore } from "@/lib/view-persistence";

// A request to show a card's text in its note, from review's Edit action. It
// waits until that note is open and has restored its view, then puts the
// caret at the start of the card's block. Not persisted, like find requests.
export type CardRevealRequest = { moduleId: string; blockId: string };

const cardRevealStore = createStore<CardRevealRequest | null>(null);

export function requestCardReveal(request: CardRevealRequest) {
  cardRevealStore.setState(() => request);
}

export function useCardReveal(editor: Editor | null, moduleId: string, ready: boolean) {
  const request = useSelector(cardRevealStore, (state) => state);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !ready || request?.moduleId !== moduleId) return;
    let start: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (start !== null) return false;
      if (!node.isTextblock) return true;
      if (node.attrs.cardId === request.blockId) start = pos + 1;
      return false;
    });
    if (start === null) return;
    cardRevealStore.setState(() => null);

    // The saved scroll position would otherwise pull the view back.
    stopScrollRestore();
    // Section focus can hide the target even after its caret moves there.
    // Clear that filter; the caret also unfolds any folded ancestor.
    editor.chain().showDocument().setTextSelection(start).focus(undefined, {
      scrollIntoView: false,
    }).run();

    // Focus runs on the next frame. Position the block after that, rather
    // than relying on caret scrolling, which only reveals the nearest edge.
    const position = start;
    requestAnimationFrame(() => {
      if (editor.isDestroyed || !editor.view.dom.isConnected) return;
      const container = editor.view.dom.closest<HTMLElement>(".app-scroll-container");
      const block = editor.view.nodeDOM(position - 1);
      if (!container || !(block instanceof HTMLElement)) return;
      const top = container.getBoundingClientRect().top + container.clientTop;
      container.scrollTop += block.getBoundingClientRect().top - top
        - Math.min(96, container.clientHeight / 4);
    });
  }, [editor, moduleId, ready, request]);
}
