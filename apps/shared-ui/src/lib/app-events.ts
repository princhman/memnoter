import { isTauri, listen } from "./backend.ts";
import { IS_MAC } from "./platform.ts";
import { action, SHORTCUTS, bindsInJS, matchesShortcut } from "./shortcuts.ts";

// AppKit owns unmodified accelerators in the native macOS app.
export function usesNativeMenuShortcuts() {
  return isTauri() && IS_MAC;
}

// App-wide requests, dispatched on window so any part of the UI can make them.
export const OPEN_SETTINGS_EVENT = "memnoter:open-settings";
export const NEW_MODULE_EVENT = "memnoter:new-module";
export const IMPORT_FOLDER_EVENT = "memnoter-import-folder";
export const FIND_EVENT = "memnoter:find";
export const TOGGLE_SIDEBAR_EVENT = "memnoter:toggle-sidebar";

export function requestApp(event: string) {
  window.dispatchEvent(new CustomEvent(event));
}

// The create dialog hosts the import dialog, so it must open first.
const APP_ACTIONS: Record<string, () => void> = {
  "settings.open": () => requestApp(OPEN_SETTINGS_EVENT),
  "module.import": () => { requestApp(NEW_MODULE_EVENT); requestApp(IMPORT_FOLDER_EVENT); },
  "module.new": () => requestApp(NEW_MODULE_EVENT),
  "find.open": () => requestApp(FIND_EVENT),
  "sidebar.toggle": () => requestApp(TOGGLE_SIDEBAR_EVENT),
};

export function listenToMenu() {
  // Native macOS owns these accelerators; other hosts need JS fallbacks.
  window.addEventListener("keydown", (event) => {
    for (const id of ["module.new", "settings.open"]) {
      const entry = action(id);
      if (bindsInJS(entry, usesNativeMenuShortcuts()) && matchesShortcut(event, entry.keys)) {
        event.preventDefault();
        APP_ACTIONS[id]();
        return;
      }
    }
  });
  listen<string>("menu", ({ payload }) => {
    const entry = SHORTCUTS.find((entry) => entry.menuId === payload);
    if (entry) APP_ACTIONS[entry.id]?.();
  }).catch(
    // Outside Tauri, e.g. the plain Vite dev server, there is no menu.
    () => {},
  );
}
