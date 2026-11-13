import { outline } from "./outline";
import { Mapping } from "@tiptap/pm/transform";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const correctionMeta = "heading-hierarchy-correction";
interface HeadingHierarchyState {
  decorations: DecorationSet;
  correctionRevision: number;
}

const headingHierarchyKey = new PluginKey<HeadingHierarchyState>(
  "heading-hierarchy",
);

export const HeadingHieararchy = Extension.create({
  name: "heading-hierarchy",
  // Handle heading starts before the list and default Backspace keymaps join
  // or lift the block. The next press can use normal paragraph behavior.
  priority: 110,
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { empty, $from } = this.editor.state.selection;
        if (
          !empty ||
          $from.parentOffset !== 0 ||
          $from.parent.type.name !== "heading"
        ) {
          return false;
        }

        return this.editor.commands.setParagraph();
      },
    };
  },
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
          const finish = (event: AnimationEvent) => {
            if (!(event.target instanceof HTMLElement) || !event.target.classList.contains("heading-auto-corrected")) return;
            if (!editorView.isDestroyed) editorView.dispatch(editorView.state.tr.setMeta(correctionMeta, []));
          };
          editorView.dom.addEventListener("animationend", finish);

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
            },
            destroy() {
              editorView.dom.removeEventListener("animationend", finish);
            },
          };
        },
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }

          const transaction = newState.tr;
          const correctedPositions: number[] = [];
          // Undo and remote Yjs updates already contain the section adjustment.
          const adjustRemoval = !transactions.some(tr =>
            isHistoryTransaction(tr) || tr.getMeta(ySyncPluginKey) ||
            tr.getMeta("heading-outline-adjustment") || tr.getMeta(correctionMeta));
          if (adjustRemoval) {
            const mapping = new Mapping();
            for (const tr of transactions) mapping.appendMapping(tr.mapping);
            const before = outline(oldState.doc);
            const removed = before.filter(heading => {
              const mapped = mapping.mapResult(heading.pos + 1);
              return mapped.deletedAcross || newState.doc.resolve(mapped.pos).parent.type.name !== "heading";
            });
            for (const heading of before) {
              const amount = removed.filter(parent => parent.pos < heading.pos && heading.pos < parent.end).length;
              if (!amount) continue;
              const mapped = mapping.mapResult(heading.pos + 1);
              if (mapped.deletedAcross) continue;
              const $pos = transaction.doc.resolve(mapped.pos);
              if ($pos.depth !== 1 || $pos.parent.type.name !== "heading") continue;
              const pos = $pos.before();
              transaction.setNodeMarkup(pos, undefined, {
                ...$pos.parent.attrs, level: Math.max(1, Number($pos.parent.attrs.level) - amount),
              });
              correctedPositions.push(pos);
            }
          }
          let previousLevel: number | null = null;

          transaction.doc.forEach((node, position) => {
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
