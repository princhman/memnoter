import { useEffect, type RefObject } from "react";
import type { Editor } from "@tiptap/core";

// The focused editor or filter input points screen readers at the list's
// highlighted option. Empty lists have no active descendant.
export function useActiveDescendant(
  editor: Editor,
  listboxId: string,
  optionId: string | null,
  focusTarget?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!optionId) return;
    const dom = focusTarget?.current ?? editor.view.dom;
    dom.setAttribute("aria-controls", listboxId);
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-activedescendant", optionId);
    return () => {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor, listboxId, optionId, focusTarget]);
}
