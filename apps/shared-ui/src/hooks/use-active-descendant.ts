import { useEffect } from "react";
import type { Editor } from "@tiptap/core";

// Focus stays in the editor while a suggestion list is open, so the editor
// points screen readers at the list's highlighted option. With no option
// (an empty list is not shown) it points nowhere.
export function useActiveDescendant(
  editor: Editor,
  listboxId: string,
  optionId: string | null,
) {
  useEffect(() => {
    if (!optionId) return;
    const dom = editor.view.dom;
    dom.setAttribute("aria-controls", listboxId);
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-activedescendant", optionId);
    return () => {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor, listboxId, optionId]);
}
