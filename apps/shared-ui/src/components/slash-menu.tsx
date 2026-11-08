import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { InsertMenu, filterItems, type InsertMenuHandle, type InsertMenuProps, type InsertItem, type InsertCommandOptions } from "./insert-menu";
import { editorContextMenu } from "./editor-context-menu";

// Typing  /  in raw text such as formulas or code is literal.
const RAW_TEXT_NODES = new Set(["codeBlock", "mathBlock", "inlineMath"]);

export const SlashCommand = Extension.create<InsertCommandOptions>({
  name: "slash-command",
  // Arrow keys and Enter go to the open menu before other extensions.
  priority: 200,

  addOptions() {
    return { insertImages: () => {} };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const suggestionKey = new PluginKey("slash-command");
    return [
      editorContextMenu(this.editor, options, suggestionKey),
      Suggestion<InsertItem, InsertItem>({
        editor: this.editor,
        pluginKey: suggestionKey,
        char: "/",
        items: ({ query, editor }) => filterItems(query, editor),
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          for (let depth = $from.depth; depth > 0; depth--) {
            if (RAW_TEXT_NODES.has($from.node(depth).type.name)) return false;
          }
          return true;
        },
        command: ({ editor, range, props }) => props.run(editor, range, options),
        render: () => {
          let renderer: ReactRenderer<InsertMenuHandle, InsertMenuProps> | null =
            null;
          let unmount: (() => void) | null = null;

          return {
            onStart: (props) => {
              renderer = new ReactRenderer(InsertMenu, {
                props,
                editor: props.editor,
                // The wrapper is what gets positioned, so it carries the layer.
                className: "z-50",
              });
              unmount = props.mount?.(renderer.element) ?? null;
            },
            onUpdate: (props) => renderer?.updateProps(props),
            onKeyDown: (props) => renderer?.ref?.onKeyDown(props) ?? false,
            onExit: () => {
              unmount?.();
              renderer?.destroy();
              unmount = null;
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
