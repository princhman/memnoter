import { Extension } from "@tiptap/core";
import { EditorState, PluginKey, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { appStore } from "./store";
import type { Editor } from "@tiptap/core";

export const sectionFocusKey = new PluginKey<number | null>("section-focus");
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
  if (focusedPos == null) return [];

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

export const SectionFocus = Extension.create({
  name: "section-focus",
  addCommands() {
    return {
      showSection:
        (headingPos: number) =>
        ({ state, dispatch }) => {
          dispatch?.(
            state.tr.setMeta(sectionFocusKey, {
              type: "show",
              position: headingPos,
            }),
          );
          appStore.setState((state) => ({
            ...state,
            focusedSectionByModule: {
              ...state.focusedSectionByModule,
              [state.openedModuleId!]: headingPos,
            },
          }));
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
              return action?.position;
            }

            if (currentPosition !== null && transaction.docChanged) {
              const mapping = transaction.mapping.mapResult(currentPosition);

              return mapping.deleted ? null : mapping.pos;
            }
            return currentPosition;
          },
        },

        props: {
          decorations(state: EditorState) {
            const headingPos = sectionFocusKey.getState(state);

            if (headingPos === null || headingPos === undefined)
              return DecorationSet.empty;

            const heading = state.doc.nodeAt(headingPos);

            if (heading?.type.name !== "heading") {
              return DecorationSet.empty;
            }

            const level = heading.attrs.level;
            let sectionEnd = state.doc.content.size;
            if (!sectionEnd) return DecorationSet.empty;

            state.doc.nodesBetween(
              headingPos + heading.nodeSize,
              state.doc.content.size,
              (node, pos) => {
                if (
                  sectionEnd === state.doc.content.size &&
                  node.type.name === "heading" &&
                  node.attrs.level <= level
                ) {
                  sectionEnd = pos;
                }

                return false;
              },
            );

            const decorations: Decoration[] = [];

            state.doc.forEach((node, pos) => {
              const nodeEnd = pos + node.nodeSize;
              const isOutsideSection =
                nodeEnd <= headingPos || pos >= sectionEnd;

              if (isOutsideSection) {
                decorations.push(
                  Decoration.node(pos, nodeEnd, {
                    class: "section-hidden",
                  }),
                );
              }
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
