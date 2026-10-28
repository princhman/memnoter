import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { getSectionRange, sectionFocusKey } from "./section-focus";

export type SectionKind = "sibling" | "subsection";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sections: {
      // Adds a heading on the level of the section the cursor is in, or one
      // level below it.
      insertSection: (kind: SectionKind) => ReturnType;
    };
  }
}

const MAX_LEVEL = 6;

// The nearest heading at or before the top-level block holding the cursor,
// and where its section ends.
function currentSection(state: EditorState) {
  const { $from } = state.selection;
  const blockPos = $from.depth > 0 ? $from.before(1) : $from.pos;
  let heading: { pos: number; level: number } | null = null;
  let end = state.doc.content.size;

  state.doc.forEach((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level);
    if (pos <= blockPos) {
      heading = { pos, level };
      end = state.doc.content.size;
    } else if (heading && end === state.doc.content.size && level <= heading.level) {
      end = pos;
    }
  });

  return { blockPos, heading: heading as { pos: number; level: number } | null, end };
}

export const Sections = Extension.create({
  name: "sections",

  addCommands() {
    return {
      insertSection:
        (kind) =>
        ({ state, tr, dispatch, commands }) => {
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

          // A section outside the focused one would be hidden; focus it instead.
          const focusedPos = sectionFocusKey.getState(state);
          if (focusedPos != null) {
            const range = getSectionRange(tr.doc, tr.mapping.map(focusedPos));
            if (!range || headingPos < range.from || headingPos >= range.to) {
              commands.showSection(headingPos);
            }
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Alt-s": () => this.editor.commands.insertSection("sibling"),
      "Mod-Alt-d": () => this.editor.commands.insertSection("subsection"),
    };
  },
});
