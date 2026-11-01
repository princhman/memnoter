import type { Editor } from "@tiptap/core";
import { createStore, useSelector } from "@tanstack/react-store";
import { useEffect } from "react";
import { stopScrollRestore } from "@/lib/view-persistence";

// A request to show a card's text in its note, from review's Edit action. It
// waits until that note is open and has restored its view, then puts the
// caret at the end of the card's block. Not persisted, like find requests.
export type CardRevealRequest = { moduleId: string; blockId: string };

const cardRevealStore = createStore<CardRevealRequest | null>(null);

export function requestCardReveal(request: CardRevealRequest) {
  cardRevealStore.setState(() => request);
}

export function useCardReveal(editor: Editor | null, moduleId: string, ready: boolean) {
  const request = useSelector(cardRevealStore, (state) => state);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !ready || request?.moduleId !== moduleId) return;
    cardRevealStore.setState(() => null);

    let end: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (end !== null) return false;
      if (!node.isTextblock) return true;
      if (node.attrs.cardId === request.blockId) end = pos + node.nodeSize - 1;
      return false;
    });
    if (end === null) return;

    // The saved scroll position would otherwise pull the view back.
    stopScrollRestore();
    // A caret inside a folded section unfolds it.
    editor.chain().focus().setTextSelection(end).scrollIntoView().run();
  }, [editor, moduleId, ready, request]);
}
