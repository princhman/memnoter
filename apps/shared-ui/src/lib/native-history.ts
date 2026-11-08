import { useEffect, useRef } from "react";
import { listen } from "./backend.ts";
import { capabilities } from "./backend.ts";
import { call as invoke } from "./backend.ts";

let nativeHistoryUpdates = Promise.resolve();

// Routes the app menu's Undo and Redo, and their shortcuts, to the app as
// `menu` events instead of the webview's native text undo. Calls are applied
// in order, so a delayed one never overrides a newer one.
export function setNativeEditorHistory(editorFocused: boolean) {
  if (!capabilities.nativeHistory) return;
  nativeHistoryUpdates = nativeHistoryUpdates
    .then(() => invoke<void>("set_editor_history", { editorFocused }))
    .catch((error) => {
      console.error("Failed to route native history", error);
    });
}

export function useNativeHistory(handlers: { enabled(): boolean; undo(): unknown; redo(): unknown }, owner: unknown) {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    if (!owner || !capabilities.nativeHistory) return;
    let disposed = false;
    const update = () => setNativeEditorHistory(current.current.enabled());
    const unlisten = listen<string>("menu", ({ payload }) => {
      if (disposed || !current.current.enabled()) return;
      if (payload === "editor-undo") current.current.undo();
      if (payload === "editor-redo") current.current.redo();
    });
    void unlisten.then(() => { if (!disposed) update(); }).catch(console.error);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      disposed = true;
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      setNativeEditorHistory(false);
      void unlisten.then(stop => stop()).catch(console.error);
    };
  }, [owner]);
}
