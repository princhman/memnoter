import type { Editor } from "@tiptap/core";
import { sectionFocusKey } from "../lib/section-focus.ts";
import { headingFoldKey } from "../lib/heading-fold.ts";

export function editorOutline(editor: Editor) {
  const folded = headingFoldKey.getState(editor.state)?.folded ?? [];
  const headings: { id: string; level: number; text: string; pos: number; folded: boolean }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading" && typeof node.attrs["data-toc-id"] === "string") {
      const id = node.attrs["data-toc-id"] as string;
      headings.push({ id, level: Number(node.attrs.level), text: node.textContent, pos, folded: folded.includes(id) });
    }
  });
  return headings;
}

export function editorState(editor: Editor) {
  const marks = ["bold", "italic", "underline", "strike", "code", "link"].filter(mark => editor.isActive(mark));
  const focusedPos = sectionFocusKey.getState(editor.state);
  const focusedHeading = focusedPos == null ? null : editor.state.doc.nodeAt(focusedPos);
  const caretHeading = editor.state.selection.$from.parent;
  return {
    focusedSectionId: focusedHeading?.attrs["data-toc-id"] ?? null,
    headingId: caretHeading.type.name === "heading" ? caretHeading.attrs["data-toc-id"] ?? null : null,
    marks, blockType: editor.state.selection.$from.parent.type.name,
    headingLevel: editor.isActive("heading") ? Number(editor.getAttributes("heading").level) : null,
    bulletList: editor.isActive("bulletList"), orderedList: editor.isActive("orderedList"),
    blockquote: editor.isActive("blockquote"),
    canUndo: editor.can().undo(), canRedo: editor.can().redo(),
    hasSelection: !editor.state.selection.empty, editable: editor.isEditable,
  };
}

// Keep the protocol explicit: never dispatch an arbitrary name into editor.commands.
export function execEditor(editor: Editor, command: string, args: Record<string, unknown> = {}): boolean {
  const commands = editor.commands;
  switch (command) {
    case "bold": return commands.toggleBold();
    case "italic": return commands.toggleItalic();
    case "underline": return commands.toggleUnderline();
    case "strike": return commands.toggleStrike();
    case "code": return commands.toggleCode();
    case "paragraph": return commands.setParagraph();
    case "heading":
      if (args.level !== 1 && args.level !== 2 && args.level !== 3) throw new Error("heading requires level 1, 2 or 3");
      return commands.setHeading({ level: args.level });
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
    case "showDocument": return commands.showDocument();
    case "insertImage":
      if (typeof args.fileId !== "string" || !args.fileId) throw new Error("insertImage requires fileId");
      return commands.insertContent({ type: "image", attrs: { fileId: args.fileId, alt: typeof args.alt === "string" ? args.alt : null } });
    case "fold":
    case "unfold":
    case "focusSection":
    case "scrollToHeading": {
      const heading = editorOutline(editor).find(item => item.id === args.id);
      if (!heading) throw new Error("Unknown heading id");
      if (command === "focusSection") return commands.showSection(heading.pos);
      if (command === "scrollToHeading") {
        commands.showDocument();
        commands.setTextSelection(heading.pos + 1);
        const dom = editor.view.nodeDOM(heading.pos);
        if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start" });
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
