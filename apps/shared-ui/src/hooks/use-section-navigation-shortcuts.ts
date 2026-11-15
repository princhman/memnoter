import { useEffect } from "react";
import { useModuleSectionNavigation, useModuleSectionScope, type ModuleSection } from "@/components/module-section-menu";
import { action, matchesShortcut } from "@/lib/shortcuts";
import { useBankGate } from "@/lib/question-bank";

const SECTIONS: readonly ModuleSection[] = ["notes", "files", "questions", "review"];
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="search"], [role="combobox"]';
const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .ProseMirror, [role="textbox"], [role="searchbox"]';

function acceptsNavigation(event: KeyboardEvent, allowNoteEditor = false) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return false;
  const blocked = (target: Element) => {
    if (target.closest(OVERLAYS)) return true;
    const field = target.closest(FIELDS);
    return !!field && !(allowNoteEditor && field.matches('.ProseMirror') && field.closest('[data-pdf-note]'));
  };
  if (event.composedPath().some(target => target instanceof Element && blocked(target))) return false;
  if (document.activeElement && blocked(document.activeElement)) return false;
  // Portalled menus/dialogs can be open before they receive keyboard focus.
  return !Array.from(document.querySelectorAll(OVERLAYS)).some(element => element.getClientRects().length > 0);
}

export function useSectionNavigationShortcuts() {
  const navigateSection = useModuleSectionNavigation();
  const moduleId = useModuleSectionScope();
  const bankEnabled = useBankGate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const global = SECTIONS.find(section => section !== "notes" && (section !== "questions" || bankEnabled) && matchesShortcut(event, action(`navigation.all.${section}`).keys));
      if (global && acceptsNavigation(event, true)) {
        event.preventDefault(); event.stopPropagation();
        void navigateSection(global, undefined, { sharedQuestions: true });
        return;
      }
      const direct = SECTIONS.find(section => (section !== "questions" || bankEnabled) && matchesShortcut(event, action(`navigation.${section}`).keys));
      if (direct && acceptsNavigation(event, true)) {
        event.preventDefault(); event.stopPropagation();
        void navigateSection(direct, moduleId);
      }
    };
    // Capture Option navigation before note input (including Option dead keys).
    // Unmodified typing in the editor is never intercepted.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [navigateSection, moduleId, bankEnabled]);
}
