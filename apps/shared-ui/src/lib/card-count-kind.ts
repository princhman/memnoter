export type CardCountKind = "new" | "learning" | "review";

// FSRS states: 0 new, 1 learning, 2 review, 3 relearning.
export function cardCountKind(state: number): CardCountKind {
  return state === 0 ? "new" : state === 2 ? "review" : "learning";
}

