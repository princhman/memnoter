import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const correctionMeta = "heading-hierarchy-correction";
const animationDurationMs = 1_500;
interface HeadingHierarchyState {
  decorations: DecorationSet;
  correctionRevision: number;
}

const headingHierarchyKey = new PluginKey<HeadingHierarchyState>(
  "heading-hierarchy",
);

export const HeadingHieararchy = Extension.create({
  name: "heading-hierarchy",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: headingHierarchyKey,
        state: {
          init: (): HeadingHierarchyState => ({
            decorations: DecorationSet.empty,
            correctionRevision: 0,
          }),
          apply(transaction, pluginState) {
            const correctedPositions = transaction.getMeta(correctionMeta) as
              number[] | undefined;

            if (correctedPositions === undefined) {
              return {
                ...pluginState,
                decorations: pluginState.decorations.map(
                  transaction.mapping,
                  transaction.doc,
                ),
              };
            }

            const headingDecorations = correctedPositions.flatMap(
              (position) => {
                const node = transaction.doc.nodeAt(position);

                if (!node || node.type.name !== "heading") {
                  return [];
                }

                return [
                  Decoration.node(position, position + node.nodeSize, {
                    class: "heading-auto-corrected",
                  }),
                ];
              },
            );

            return {
              decorations: DecorationSet.create(
                transaction.doc,
                headingDecorations,
              ),
              correctionRevision:
                pluginState.correctionRevision +
                (correctedPositions.length ? 1 : 0),
            };
          },
        },
        props: {
          decorations(state) {
            return headingHierarchyKey.getState(state)?.decorations ?? null;
          },
        },
        view(editorView) {
          let clearAnimationTimer: ReturnType<typeof setTimeout> | undefined;

          return {
            update(view, previousState) {
              const pluginState = headingHierarchyKey.getState(view.state);
              const previousPluginState =
                headingHierarchyKey.getState(previousState);

              if (
                !pluginState ||
                pluginState.correctionRevision ===
                  previousPluginState?.correctionRevision ||
                !pluginState.decorations.find().length
              ) {
                return;
              }

              pluginState.decorations.find().forEach((decoration) => {
                const element = view.nodeDOM(decoration.from);

                if (!(element instanceof HTMLElement)) {
                  return;
                }

                element.classList.remove("heading-auto-corrected");
                void element.offsetWidth;
                element.classList.add("heading-auto-corrected");
              });

              clearTimeout(clearAnimationTimer);
              clearAnimationTimer = setTimeout(() => {
                if (!editorView.isDestroyed) {
                  editorView.dispatch(
                    editorView.state.tr.setMeta(correctionMeta, []),
                  );
                }
              }, animationDurationMs);
            },
            destroy() {
              clearTimeout(clearAnimationTimer);
            },
          };
        },
        appendTransaction(transactions, __oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }

          const transaction = newState.tr;
          const correctedPositions: number[] = [];
          let previousLevel: number | null = null;

          newState.doc.forEach((node, position) => {
            if (node.type.name !== "heading") {
              return;
            }

            const currentLevel = Number(node.attrs.level);
            const validLevel =
              previousLevel === null
                ? 1
                : Math.min(currentLevel, previousLevel + 1);

            if (currentLevel !== validLevel) {
              transaction.setNodeMarkup(
                position,
                undefined,
                {
                  ...node.attrs,
                  level: validLevel,
                },
                node.marks,
              );
              correctedPositions.push(position);
            }
            previousLevel = validLevel;
          });

          if (!correctedPositions.length) {
            return null;
          }

          transaction.setMeta(correctionMeta, correctedPositions);
          return transaction;
        },
      }),
    ];
  },
});
