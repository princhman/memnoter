import { call as invoke } from "./backend.ts";

let nativeHistoryUpdates = Promise.resolve();

// Routes the app menu's Undo and Redo, and their shortcuts, to the app as
// `menu` events instead of the webview's native text undo. Calls are applied
// in order, so a delayed one never overrides a newer one.
export function setNativeEditorHistory(editorFocused: boolean) {
  nativeHistoryUpdates = nativeHistoryUpdates
    .then(() => invoke<void>("set_editor_history", { editorFocused }))
    .catch((error) => {
      if ("__TAURI_INTERNALS__" in window) {
        console.error("Failed to route native history", error);
      }
    });
}
