import { Extension } from "@tiptap/core";
import { EditorState, PluginKey, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";

export const sectionFocusKey = new PluginKey<number | null>("section-focus");

function isHeadingPosition(
  doc: EditorState["doc"],
  position: unknown,
): position is number {
  return (
    typeof position === "number" &&
    Number.isInteger(position) &&
    position >= 0 &&
    position < doc.content.size &&
    doc.nodeAt(position)?.type.name === "heading"
  );
}
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sectionFocus: {
      showSection: (headingPos: number) => ReturnType;
      showDocument: () => ReturnType;
    };
  }
}

type SectionCrumb = {
  pos: number;
  level: number;
  title: string;
};

export function getFocusedSectionPath(editor: Editor): SectionCrumb[] {
  const focusedPos = sectionFocusKey.getState(editor.state);
  if (
    focusedPos == null ||
    focusedPos < 0 ||
    focusedPos >= editor.state.doc.content.size
  ) return [];

  const focusedNode = editor.state.doc.nodeAt(focusedPos);
  if (focusedNode?.type.name !== "heading") return [];

  const path: SectionCrumb[] = [];

  editor.state.doc.forEach((node, pos) => {
    if (pos > focusedPos || node.type.name !== "heading") return;

    const level = Number(node.attrs.level);

    while (path.length && path[path.length - 1].level >= level) {
      path.pop();
    }

    path.push({
      pos,
      level,
      title: node.textContent || "Untitled section",
    });
  });

  return path;
}

// The focused heading and everything up to the next heading at its level or higher.
export function getFocusedSectionRange(
  state: EditorState,
): { from: number; to: number } | null {
  return getSectionRange(state.doc, sectionFocusKey.getState(state));
}

// A heading and everything up to the next heading at its level or higher.
export function getSectionRange(
  doc: EditorState["doc"],
  headingPos: unknown,
): { from: number; to: number } | null {
  if (!isHeadingPosition(doc, headingPos)) return null;

  const heading = doc.nodeAt(headingPos);
  if (heading?.type.name !== "heading") return null;

  const level = heading.attrs.level;
  let sectionEnd = doc.content.size;

  doc.nodesBetween(
    headingPos + heading.nodeSize,
    doc.content.size,
    (node, pos) => {
      if (
        sectionEnd === doc.content.size &&
        node.type.name === "heading" &&
        node.attrs.level <= level
      ) {
        sectionEnd = pos;
      }

      return false;
    },
  );

  return { from: headingPos, to: sectionEnd };
}

const sectionMarksKey = new PluginKey<DecorationSet>("section-focus-marks");

// Marks only the focused heading and the first block after its section; CSS
// hides everything outside them. A decoration per hidden block would cost
// time on every keystroke in long notes, as ProseMirror checks each top-level
// decoration against each block.
function buildSectionMarks(state: EditorState): DecorationSet {
  const range = getFocusedSectionRange(state);
  if (!range) return DecorationSet.empty;

  const heading = state.doc.nodeAt(range.from)!;
  const decorations = [
    Decoration.node(range.from, range.from + heading.nodeSize, {
      class: "section-focus-start",
    }),
  ];
  const after = state.doc.nodeAt(range.to);
  if (after) {
    decorations.push(
      Decoration.node(range.to, range.to + after.nodeSize, {
        class: "section-focus-end",
      }),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

export const SectionFocus = Extension.create({
  name: "section-focus",
  addCommands() {
    return {
      showSection:
        (headingPos: number) =>
        ({ state, dispatch }) => {
          if (!isHeadingPosition(state.doc, headingPos)) return false;
          dispatch?.(
            state.tr.setMeta(sectionFocusKey, {
              type: "show",
              position: headingPos,
            }),
          );
          return true;
        },
      showDocument:
        () =>
        ({ state, dispatch }) => {
          dispatch?.(state.tr.setMeta(sectionFocusKey, { type: "clear" }));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: sectionFocusKey,
        state: {
          init: () => null,
          apply(transaction, currentPosition) {
            const action = transaction.getMeta(sectionFocusKey);

            if (action?.type === "clear") {
              return null;
            }

            if (action?.type === "show") {
              return isHeadingPosition(transaction.doc, action.position)
                ? action.position
                : null;
            }

            if (currentPosition !== null && transaction.docChanged) {
              const mapping = transaction.mapping.mapResult(currentPosition, -1);
              return !mapping.deleted &&
                isHeadingPosition(transaction.doc, mapping.pos)
                ? mapping.pos
                : null;
            }
            return currentPosition;
          },
        },
      }),
      new Plugin<DecorationSet>({
        key: sectionMarksKey,
        state: {
          init: (_, state) => buildSectionMarks(state),
          apply: (transaction, value, _oldState, newState) =>
            transaction.docChanged || transaction.getMeta(sectionFocusKey)
              ? buildSectionMarks(newState)
              : value,
        },
        props: {
          decorations: (state) => sectionMarksKey.getState(state),
          attributes: (state): Record<string, string> =>
            sectionMarksKey.getState(state) === DecorationSet.empty
              ? {}
              : { class: "section-focused" },
        },
      }),
    ];
  },
});
