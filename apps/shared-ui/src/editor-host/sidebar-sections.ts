import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { createID, UndoManager } from "yjs";
import { call } from "../lib/backend";
import { reconcileContent, type GetContentResponse } from "../lib/content";
import { isSchemaReadOnly } from "../lib/guarded-collaboration";
import { getFoldedIds, getFoldedRanges } from "../lib/heading-fold";
import { TOC_ID_ATTRIBUTE } from "../lib/outline";
import { NEWER_VERSION_MESSAGE } from "../lib/schema-compatibility";
import { resolveSidebarSection, savedSidebarSections, type SidebarTarget } from "../lib/sidebar-section-data";
import { flushPersistedViews, stopScrollRestore } from "../lib/view-persistence";
import { execEditor } from "./commands";
import type { SidebarNavigationResult, SidebarSectionSnapshot } from "./protocol";
import { sectionToTop } from "./scroll";

export async function readSidebarSections(moduleId: string): Promise<SidebarSectionSnapshot> {
  // loadContent also cleans up files on first open. This route only reads.
  try {
    const content = await call<GetContentResponse>("get_content", { moduleId });
    const result = savedSidebarSections(moduleId, reconcileContent(moduleId, content));
    if (result.kind === "ready") return { sections: result.sections };
    if (result.kind === "newer") return { sections: [], error: NEWER_VERSION_MESSAGE };
  } catch {
    // A note read failure stays under its module in the sidebar.
  }
  return { sections: [], error: "Sections could not be loaded." };
}

export function parseSidebarTarget(value: unknown): SidebarTarget {
  if (value && typeof value === "object" && "kind" in value) {
    if (value.kind === "add" || value.kind === "document") return { kind: value.kind };
    if (value.kind === "heading" && "id" in value && typeof value.id === "string" && value.id) {
      return { kind: "heading", id: value.id };
    }
    if (value.kind === "legacy-heading" && "itemId" in value && value.itemId && typeof value.itemId === "object") {
      const item = value.itemId;
      if ("client" in item && typeof item.client === "number" && Number.isSafeInteger(item.client) && item.client >= 0 &&
          "clock" in item && typeof item.clock === "number" && Number.isSafeInteger(item.clock) && item.clock >= 0) {
        return { kind: "legacy-heading", itemId: createID(item.client, item.clock) };
      }
    }
  }
  throw new Error("Invalid sidebar destination.");
}

export function navigateSidebar(editor: Editor, target: SidebarTarget): SidebarNavigationResult {
  if (target.kind === "document") {
    stopScrollRestore();
    execEditor(editor, "showDocument");
  } else if (target.kind === "add") {
    if (!editor.isEditable || isSchemaReadOnly(editor)) return "read-only";
    stopScrollRestore();
    const end = editor.state.doc.content.size;
    const undo: unknown = yUndoPluginKey.getState(editor.state)?.undoManager;
    // Give the insertion its own undo step even if the previous edit was recent.
    if (undo instanceof UndoManager) undo.stopCapturing();
    const inserted = editor.chain()
      .insertContentAt(end, { type: "heading", attrs: { level: 1, [TOC_ID_ATTRIBUTE]: crypto.randomUUID() } })
      .setTextSelection(end + 1).showSection(end).run();
    if (undo instanceof UndoManager) undo.stopCapturing();
    if (!inserted) return "unavailable";
    // Focus during the WKWebView call, while WebKit permits keyboard activation.
    editor.view.focus();
    sectionToTop(editor, end);
  } else {
    if (isSchemaReadOnly(editor)) return "unavailable";
    const heading = resolveSidebarSection(editor.state, target);
    if (!heading) return "unavailable";
    stopScrollRestore();
    const hidden = new Set(getFoldedRanges(editor.state).filter(range => range.heading === heading.pos
      || (heading.pos >= range.from && heading.pos < range.to)).map(range => range.id));
    if (hidden.size) editor.commands.setFolds(getFoldedIds(editor.state).filter(id => !hidden.has(id)));
    editor.chain().setTextSelection(heading.pos + 1).showSection(heading.pos).run();
    sectionToTop(editor, heading.pos);
  }
  flushPersistedViews();
  return "applied";
}
