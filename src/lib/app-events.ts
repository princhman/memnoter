import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appStore, setSidebarOpen } from "@/lib/store";

// AppKit owns unmodified accelerators in the native macOS app.
export function usesNativeMenuShortcuts() {
  return isTauri() && /Mac/.test(navigator.platform);
}

// App-wide requests, dispatched on window so any part of the UI can make them.
export const OPEN_SETTINGS_EVENT = "memnoter:open-settings";
export const NEW_MODULE_EVENT = "memnoter:new-module";
export const FIND_EVENT = "memnoter:find";

export function requestApp(event: string) {
  window.dispatchEvent(new CustomEvent(event));
}

// Ids of the custom items in the native menu (src-tauri/src/menu.rs).
const MENU_ACTIONS: Record<string, () => void> = {
  settings: () => requestApp(OPEN_SETTINGS_EVENT),
  "new-module": () => requestApp(NEW_MODULE_EVENT),
  find: () => requestApp(FIND_EVENT),
  "toggle-sidebar": () => setSidebarOpen(!appStore.state.sidebarOpen),
};

export function listenToMenu() {
  listen<string>("menu", ({ payload }) => MENU_ACTIONS[payload]?.()).catch(
    // Outside Tauri, e.g. the plain Vite dev server, there is no menu.
    () => {},
  );
}
