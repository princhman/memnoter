import type { Node } from "@tiptap/pm/model";
import { createStore } from "@tanstack/react-store";

// A request for the find bar, from outside it (the ⌘K palette, the "Find in
// note" command). It waits until the note in `moduleId` is ready, then opens
// the bar. With `terms`, it searches the first term that matches anything and
// reveals and selects the first match. Kept out of appStore, which is
// persisted, so a request never outlives the session.
export type FindRequest = {
  moduleId: string | null;
  terms: string[];
};

export const findRequestStore = createStore<FindRequest | null>(null);

export function requestFind(request: FindRequest) {
  findRequestStore.setState(() => request);
}

export function clearFindRequest() {
  findRequestStore.setState(() => null);
}

// The find bar skips inline formulas, but search indexes their source. The
// first case-insensitive occurrence of a term inside one, best term first.
export function findInInlineMath(doc: Node, terms: readonly string[]) {
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let found: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name !== "inlineMath") return true;
      const index = node.textContent.toLowerCase().indexOf(needle);
      if (index !== -1) found = { from: pos + 1 + index, to: pos + 1 + index + needle.length };
      return false;
    });
    if (found) return found;
  }
  return null;
}
