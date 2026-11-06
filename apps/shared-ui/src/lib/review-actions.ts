import type { CardCountKind } from "@/components/card-counts";
import type { CardCounts } from "@/lib/card-sync";
import { createStore } from "@tanstack/react-store";

// What the toolbar offers while a review is open: taking back and redoing
// grades in this session, and opening the shown card's text in its note.
export type ReviewActions = {
  counts: CardCounts | null;
  // The count the card on screen belongs to.
  current: CardCountKind | null;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  edit: (() => void) | null;
};

export const reviewActionsStore = createStore<ReviewActions | null>(null);
