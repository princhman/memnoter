import { action } from "./shortcuts.ts";
import { outline, TOC_ID_ATTRIBUTE } from "./outline.ts";
import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { getSectionRange, sectionFocusKey } from "./section-focus.ts";

export type SectionKind = "sibling" | "subsection";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sections: {
      // Adds a heading on the level of the section the cursor is in, or one
      // level below it.
      insertHeadingAbove: () => ReturnType;
      insertSection: (kind: SectionKind) => ReturnType;
    };
  }
}

const MAX_LEVEL = 6;

// The nearest heading at or before the top-level block holding the cursor,
// and where its section ends.
export function currentSection(state: EditorState) {
  const { $from } = state.selection;
  const blockPos = $from.depth > 0 ? $from.before(1) : $from.pos;
  const heading = outline(state.doc).filter(item => item.pos <= blockPos).slice(-1)[0] ?? null;
  return { blockPos, heading, end: heading?.end ?? state.doc.content.size };
}

export const Sections = Extension.create({
  name: "sections",

  addCommands() {
    return {
      insertHeadingAbove: () => ({ state, tr, commands }) => {
        if (state.selection.$from.depth !== 1) return false;
        const next = outline(state.doc).find(heading => heading.pos > state.selection.from);
        const level = next?.level ?? 1;
        if (next) {
          for (const heading of outline(state.doc)) {
            if (heading.pos < next.pos || heading.pos >= next.end) continue;
            const node = tr.doc.nodeAt(heading.pos)!;
            tr.setNodeMarkup(heading.pos, undefined, { ...node.attrs, level: Math.min(heading.level + 1, MAX_LEVEL) });
          }
        }
        tr.setMeta("heading-outline-adjustment", true);
        return commands.insertContent({ type: "heading", attrs: { level } });
      },
      insertSection:
        (kind) =>
        ({ state, tr, dispatch, commands }) => {
          // Sections belong to the note outline, never to a table cell.
          if (Array.from({ length: state.selection.$from.depth }, (_, i) =>
            state.selection.$from.node(i + 1).type.name).includes("table")) return false;
          const headingType = state.schema.nodes.heading;
          const { $from } = state.selection;
          const { heading, end } = currentSection(state);
          const level = heading
            ? Math.min(heading.level + (kind === "subsection" ? 1 : 0), MAX_LEVEL)
            : 1;

          let headingPos: number;
          const block = $from.depth > 0 ? $from.node(1) : null;
          if (block?.type.name === "paragraph" && block.content.size === 0) {
            // An empty line, e.g. one the slash menu just cleared, becomes
            // the heading itself.
            headingPos = $from.before(1);
            tr.setBlockType(headingPos, headingPos + 1, headingType, { level });
          } else {
            // Otherwise the new section goes after the current one, so it
            // does not take over the rest of that section's content.
            headingPos = end;
            tr.insert(headingPos, headingType.create({ level }));
          }
          tr.setSelection(TextSelection.create(tr.doc, headingPos + 1));
          if (!dispatch) return true;
          tr.scrollIntoView();

          // A sibling belongs outside the focused section: reveal the note and
          // keep the caret in the new heading rather than silently refocusing.
          const focusedPos = sectionFocusKey.getState(state);
          if (focusedPos != null) {
            const range = getSectionRange(tr.doc, tr.mapping.map(focusedPos));
            if (!range || headingPos < range.from || headingPos >= range.to) {
              commands.showDocument();
            }
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      [action("section.sibling").keys]: () => this.editor.commands.insertSection("sibling"),
      [action("section.child").keys]: () => this.editor.commands.insertSection("subsection"),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey("empty-heading-ids"),
      appendTransaction(transactions, _old, state) {
        if (!editor.isEditable || !transactions.some(tr => tr.docChanged) ||
          transactions.some(tr => tr.getMeta("composition"))) return null;
        return emptyHeadingIds(state);
      },
      // A note becomes editable only after it loads, without a content change.
      view: () => ({
        update(view) {
          if (!editor.isEditable || view.composing) return;
          const tr = emptyHeadingIds(view.state);
          if (tr) queueMicrotask(() => {
            const next = !view.isDestroyed && editor.isEditable ? emptyHeadingIds(view.state) : null;
            if (next) view.dispatch(next);
          });
        },
      }),
    })];
  },
});

// TableOfContents only identifies headings with text. An empty heading still
// bounds a section and takes a chapter number, so the sidebar and section moves
// need its id too. Splitting at a heading's start can also leave the empty half
// with its neighbour's id; the titled heading keeps it.
function emptyHeadingIds(state: EditorState) {
  const titled = new Set<string>();
  state.doc.forEach(node => { if (node.type.name === "heading" && node.textContent) titled.add(node.attrs[TOC_ID_ATTRIBUTE]); });
  const seen = new Set<string>();
  const tr = state.tr;
  state.doc.forEach((node, pos) => {
    if (node.type.name !== "heading" || node.textContent) return;
    const id = node.attrs[TOC_ID_ATTRIBUTE];
    if (typeof id === "string" && id && !titled.has(id) && !seen.has(id)) { seen.add(id); return; }
    const fresh = crypto.randomUUID();
    seen.add(fresh);
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, [TOC_ID_ATTRIBUTE]: fresh, id: fresh });
  });
  return tr.docChanged ? tr.setMeta("addToHistory", false) : null;
}
