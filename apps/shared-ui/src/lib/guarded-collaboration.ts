import Collaboration from "@tiptap/extension-collaboration";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, type PluginView } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import type { Transaction } from "yjs";
import { hasUnknownContent } from "./schema-compatibility";

const compatibilityKey = new PluginKey("schemaCompatibility");
export function isSchemaReadOnly(editor: Editor) {
  return compatibilityKey.getState(editor.state) === true;
}

// All note editors, including hidden backfill editors, use this binding.
export const GuardedCollaboration = Collaboration.extend({
  addProseMirrorPlugins() {
    const fragment = this.options.fragment ?? this.options.document!.getXmlFragment(this.options.field);
    const doc = fragment.doc!;
    const editor = this.editor;
    let blocked = hasUnknownContent(fragment, editor.schema);
    let syncView: PluginView | undefined;
    const plugins: Plugin[] = this.parent?.() ?? [];
    const sync = plugins.find(plugin => plugin.spec.key === ySyncPluginKey)!;
    const originalView = sync.spec.view!;
    // Neither first render nor subsequent PM transactions may enter the binding
    // after quarantine. editable:false alone does NOT stop y-tiptap write-back.
    sync.spec.view = view => {
      if (!blocked) syncView = originalView(view);
      else this.options.onFirstRender?.();
      return {
        update: (current, previous) => { if (!blocked) syncView?.update?.(current, previous); },
        destroy: () => { syncView?.destroy?.(); syncView = undefined; },
      };
    };
    const check = (transaction: Transaction) => {
      if (blocked || transaction.changed.size === 0 || !hasUnknownContent(fragment, editor.schema)) return;
      blocked = true;
      // beforeObserverCalls runs before XmlFragment.observeDeep, for every
      // source of updates (disk/cache, sync, native applyRemote, pending saves).
      syncView?.destroy?.();
      syncView = undefined;
      yUndoPluginKey.getState(editor.state)?.undoManager.clear();
      editor.setEditable(false, false);
      editor.view.dispatch(editor.state.tr.setMeta(compatibilityKey, true));
    };
    return [new Plugin({
      key: compatibilityKey,
      state: { init: () => blocked, apply: () => blocked },
      props: { editable: () => !blocked },
      filterTransaction: transaction => !blocked || !transaction.docChanged,
      view: () => {
        if (blocked) editor.setEditable(false, false);
        doc.on("beforeObserverCalls", check);
        return { destroy: () => doc.off("beforeObserverCalls", check) };
      },
    }), ...plugins];
  },
});
