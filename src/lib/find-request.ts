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
