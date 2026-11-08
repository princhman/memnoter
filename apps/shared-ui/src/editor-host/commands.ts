import { outline, headingId, UNTITLED_SECTION } from "../lib/outline.ts";
import { sectionOffset, sectionToTop } from "./scroll.ts";
import { suppressesTextInput } from "../lib/editor-input.ts";
import type { Editor } from "@tiptap/core";
import { getFocusedSectionPath, getFocusedSectionRange, sectionFocusKey } from "../lib/section-focus.ts";
import { currentSection } from "../lib/sections.ts";
import { headingFoldKey, getFoldedRanges } from "../lib/heading-fold.ts";

// TOC deliberately skips empty headings. Native focus still needs an opaque,
// resolvable ID for every section, including empty ancestors. Position IDs are
// refreshed with state/outline on each transaction and never persisted.
function sectionId(node: Parameters<typeof headingId>[0], pos: number): string {
  const id = headingId(node);
  return typeof id === "string" && id ? id : `native-section:${pos}`;
}

function allHeadings(editor: Editor) {
  const folded = headingFoldKey.getState(editor.state)?.folded ?? [];
  return outline(editor.state.doc).map(heading => {
    const id = heading.id ?? `native-section:${heading.pos}`;
    return { id, level: heading.level, text: heading.title, pos: heading.pos, folded: folded.includes(id) };
  });
}

// Use document positions from the same state as the visibility plugins.
export function editorOutline(editor: Editor) {
  const focus = getFocusedSectionRange(editor.state);
  const folded = getFoldedRanges(editor.state);
  return allHeadings(editor).filter(item =>
    (!focus || (item.pos >= focus.from && item.pos < focus.to)) &&
    !folded.some(range => item.pos >= range.from && item.pos < range.to));
}

export function editorState(editor: Editor) {
  const marks = ["bold", "italic", "underline", "strike", "code", "link", "highlight"].filter(mark => editor.isActive(mark));
  const focusedPos = sectionFocusKey.getState(editor.state);
  const focusedHeading = focusedPos == null ? null : editor.state.doc.nodeAt(focusedPos);
  const caretHeading = editor.state.selection.$from.parent;
  const { heading } = currentSection(editor.state);
  const sectionNode = heading ? editor.state.doc.nodeAt(heading.pos) : null;
  return {
    focusableSection: heading && sectionNode ? {
      pos: heading.pos, id: sectionId(sectionNode, heading.pos),
      title: sectionNode.textContent.trim() || UNTITLED_SECTION, level: heading.level,
    } : null,
    focusedSectionPath: getFocusedSectionPath(editor).map(crumb => ({
      id: sectionId(editor.state.doc.nodeAt(crumb.pos)!, crumb.pos),
      level: crumb.level, title: crumb.title,
    })),
    focusedSectionId: focusedHeading ? sectionId(focusedHeading, focusedPos!) : null,
    headingId: caretHeading.type.name === "heading" ? sectionId(caretHeading, editor.state.selection.$from.before()) : null,
    highlightColor: editor.isActive("highlight") ? editor.getAttributes("highlight").color : null,
    marks, blockType: editor.state.selection.$from.parent.type.name,
    headingLevel: editor.isActive("heading") ? Number(editor.getAttributes("heading").level) : null,
    bulletList: editor.isActive("bulletList"), orderedList: editor.isActive("orderedList"),
    blockquote: editor.isActive("blockquote"),
    inTable: editor.isActive("table"),
    canMergeCells: editor.can().mergeCells(), canSplitCell: editor.can().splitCell(),
    canIndent: editor.can().sinkListItem("listItem"),
    canOutdent: editor.can().liftListItem("listItem"),
    canMakeCard: editor.can().makeCloze(), inCloze: editor.can().removeCloze(),
    canJoinClozes: editor.can().joinClozes(),
    folded: editor.can().unfoldCurrentSection(),
    canFold: editor.can().foldCurrentSection(),
    canUndo: editor.can().undo(), canRedo: editor.can().redo(),
    hasSelection: !editor.state.selection.empty, editable: editor.isEditable,
    suppressKeyboard: suppressesTextInput(editor.state.selection),
  };
}

// Keep the protocol explicit: never dispatch an arbitrary name into editor.commands.
export function execEditor(editor: Editor, command: string, args: Record<string, unknown> = {}): boolean {
  const commands = editor.commands;
  switch (command) {
    case "insertTable": return editor.isActive("table") ? false : commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true });
    case "addRowBefore": return commands.addRowBefore();
    case "addRowAfter": return commands.addRowAfter();
    case "addColumnBefore": return commands.addColumnBefore();
    case "addColumnAfter": return commands.addColumnAfter();
    case "deleteRow": return commands.deleteRow();
    case "deleteColumn": return commands.deleteColumn();
    case "toggleHeaderRow": return commands.toggleHeaderRow();
    case "mergeCells": return commands.mergeCells();
    case "splitCell": return commands.splitCell();
    case "deleteTable": return commands.deleteTable();
    case "bold": return commands.toggleBold();
    case "italic": return commands.toggleItalic();
    case "underline": return commands.toggleUnderline();
    case "strike": return commands.toggleStrike();
    case "highlight": return commands.toggleHighlight(typeof args.color === "string" ? { color: args.color } : undefined);
    case "setHighlight":
      if (typeof args.color !== "string") throw new Error("setHighlight requires color");
      return commands.setHighlight({ color: args.color });
    case "removeHighlight": return commands.unsetHighlight();
    case "code": return commands.toggleCode();
    case "paragraph": return commands.setParagraph();
    case "heading":
      if (typeof args.level !== "number" || ![1, 2, 3, 4, 5, 6].includes(args.level)) throw new Error("heading requires level 1–6");
      return commands.setHeading({ level: args.level as 1 | 2 | 3 | 4 | 5 | 6 });
    case "bulletList": return commands.toggleBulletList();
    case "orderedList": return commands.toggleOrderedList();
    case "blockquote": return commands.toggleBlockquote();
    case "inlineMath": return commands.insertInlineMath(typeof args.tex === "string" ? args.tex : undefined);
    case "mathBlock": return commands.toggleMathBlock();
    case "link":
      if (args.href === null || args.href === "") return commands.unsetLink();
      if (typeof args.href !== "string") throw new Error("link requires href");
      return commands.setLink({ href: args.href });
    case "undo": return commands.undo();
    case "redo": return commands.redo();
    case "makeCard": return commands.makeCloze();
    case "removeCard": return commands.removeCloze();
    case "joinClozes": return commands.joinClozes();
    case "codeBlock": return commands.toggleCodeBlock();
    case "insertSection":
      if (args.kind !== "sibling" && args.kind !== "subsection") throw new Error("insertSection requires sibling or subsection");
      return commands.insertSection(args.kind);
    // These are the list keymap's Tab / Shift-Tab commands. Do not fall
    // through to prose tab insertion when the selection is outside a list.
    case "indent": return commands.sinkListItem("listItem");
    case "outdent": return commands.liftListItem("listItem");
    case "foldCurrentSection": return commands.foldCurrentSection();
    case "unfoldCurrentSection": return commands.unfoldCurrentSection();
    case "focusCurrentSection": {
      const { heading } = currentSection(editor.state);
      if (!heading) return false;
      const result = commands.showSection(heading.pos);
      sectionToTop(editor, heading.pos);
      return result;
    }
    case "showDocument": {
      const pos = sectionFocusKey.getState(editor.state);
      const offset = pos == null ? 0 : sectionOffset(editor, pos);
      const result = commands.showDocument();
      if (pos != null) sectionToTop(editor, pos, offset);
      return result;
    }
    case "insertImage":
      if (typeof args.fileId !== "string" || !args.fileId) throw new Error("insertImage requires fileId");
      return commands.insertContent({ type: "image", attrs: { fileId: args.fileId, alt: typeof args.alt === "string" ? args.alt : null } });
    case "fold":
    case "unfold":
    case "focusSection":
    case "scrollToHeading": {
      const heading = allHeadings(editor).find(item => item.id === args.id);
      if (!heading) throw new Error("Unknown heading id");
      if (command === "focusSection") {
        // Outline/breadcrumb actions can target a section outside the selection.
        // Move the caret with focus so WebKit never tries to reveal hidden text.
        const result = editor.chain().setTextSelection(heading.pos + 1).showSection(heading.pos).run();
        sectionToTop(editor, heading.pos);
        return result;
      }
      if (command === "scrollToHeading") {
        // Navigation within Contents preserves the current section focus.
        // Moving the caret also prevents a later inset update returning to it.
        commands.setTextSelection(heading.pos + 1);
        sectionToTop(editor, heading.pos);
        return true;
      }
      return heading.folded === (command === "fold") || commands.toggleFold(heading.pos);
    }
    case "find":
      if (typeof args.text !== "string") throw new Error("find requires text");
      return commands.setSearchTerm(args.text);
    default: throw new Error(`Unknown editor command: ${command}`);
  }
}
