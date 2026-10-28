import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { openUrl } from "@tauri-apps/plugin-opener";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    linkEditor: {
      // Shows the link menu's URL field for the selection.
      openLinkEditor: () => ReturnType;
      closeLinkEditor: () => ReturnType;
    };
  }
}

// The selection the URL field was opened for; moving it closes the field.
type LinkEditorState = { from: number; to: number } | null;

export const linkEditorKey = new PluginKey<LinkEditorState>("link-editor");

// Bubble menu plugin keys; a meta of "show" or "hide" sets their visibility.
export const LINK_MENU_KEY = "linkMenu";
export const TEXT_BUBBLE_MENU_KEY = "textBubbleMenu";

export function isLinkEditorOpen(state: EditorState) {
  return !!linkEditorKey.getState(state);
}

// Bare domains get https, bare addresses mailto; anything with a scheme stays.
export function normalizeHref(input: string) {
  const href = input.trim();
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(href)) return `mailto:${href}`;
  return `https://${href}`;
}

export function openLink(href: string) {
  openUrl(href).catch((error) => console.error("Failed to open link:", error));
}

export const LinkEditor = Extension.create({
  name: "linkEditor",

  addCommands() {
    return {
      openLinkEditor:
        () =>
        ({ state, tr, dispatch, editor }) => {
          // Code and formulas take no marks.
          if (!editor.can().setLink({ href: "https://" })) return false;
          if (dispatch) {
            const { from, to } = state.selection;
            tr.setMeta(linkEditorKey, { from, to })
              .setMeta(LINK_MENU_KEY, "show")
              .setMeta(TEXT_BUBBLE_MENU_KEY, "hide");
          }
          return true;
        },
      closeLinkEditor:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(linkEditorKey, null);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-l": () => this.editor.commands.openLinkEditor(),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<LinkEditorState>({
        key: linkEditorKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(linkEditorKey) as LinkEditorState | undefined;
            if (meta !== undefined) return meta;
            if (!value) return null;
            const from = tr.mapping.map(value.from);
            const to = tr.mapping.map(value.to);
            return tr.selection.from === from && tr.selection.to === to
              ? { from, to }
              : null;
          },
        },
        props: {
          // A plain click places the caret to edit the text; ⌘-click opens.
          handleClick(view, _pos, event) {
            if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) {
              return false;
            }
            const link =
              event.target instanceof Element
                ? event.target.closest<HTMLAnchorElement>("a[href]")
                : null;
            if (!link || !view.dom.contains(link)) return false;
            openLink(link.getAttribute("href")!);
            return true;
          },
        },
      }),
    ];
  },
});
