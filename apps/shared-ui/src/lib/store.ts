import type { NativeViewState } from "../editor-host/protocol";
import { isNativeHost, postNativeEvent, listen } from "./backend.ts";
import { createStore } from "@tanstack/react-store";

// Where the reader was in a module, restored when it is opened again.
export type ModuleView = {
  scrollTop: number;
  // The top-level block at the top of the viewport and its offset from it.
  // Missing in views saved before anchoring existed; scrollTop is the fallback.
  scrollAnchor?: { pos: number; offset: number };
  anchor: number;
  head: number;
  focusedSection: number | null;
  // Table-of-contents ids of folded headings. Missing in views saved before
  // folding existed.
  foldedSections?: string[];
};

type appState = {
  openedModuleId: string | null;
  viewByModule: Record<string, ModuleView>;
  sidebarOpen: boolean;
  // Most recently opened first, for the welcome screen.
  recentModuleIds: string[];
  // Review shows a card due soon when none is due yet, as Anki does.
  learnAhead: boolean;
  skipCardsCreatedToday: boolean;
};

declare global {
  interface Window { __memnoterViewState?: Partial<NativeViewState>; }
}

const RECENT_LIMIT = 20;

const STORAGE_KEY = "app-state";
const SAVE_DEBOUNCE_MS = 250;

const defaultState: appState = {
  openedModuleId: null,
  viewByModule: {},
  sidebarOpen: true,
  recentModuleIds: [],
  learnAhead: false,
  skipCardsCreatedToday: false,
};

function normalizeState(value: Partial<appState> | null): appState {
  const state = { ...defaultState, ...value };
  if (!state.viewByModule || typeof state.viewByModule !== "object" || Array.isArray(state.viewByModule)) state.viewByModule = {};
  if (!Array.isArray(state.recentModuleIds)) state.recentModuleIds = [];
  return state;
}

function loadState(): appState {
  try {
    // Custom WKURLSchemeHandler origins do not provide reliable Web Storage.
    if (isNativeHost()) {
      return normalizeState({ ...window.__memnoterViewState, skipCardsCreatedToday: false });
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    // Merge so state saved by older versions picks up new fields.
    return saved ? normalizeState(JSON.parse(saved)) : defaultState;
  } catch {
    return defaultState;
  }
}

export const appStore = createStore(loadState());

// Scrolling updates the view often; batch the disk writes.
let saveTimeout: number | undefined;

export function saveState() {
  window.clearTimeout(saveTimeout);
  saveTimeout = undefined;
  if (isNativeHost()) {
    const { skipCardsCreatedToday: _, ...viewState } = appStore.state;
    postNativeEvent("viewState", viewState);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appStore.state));
  } catch (error) {
    console.error("Failed to save app state:", error);
  }
}

appStore.subscribe(() => {
  window.clearTimeout(saveTimeout);
  saveTimeout = window.setTimeout(saveState, SAVE_DEBOUNCE_MS);
});

window.addEventListener("pagehide", saveState);
window.addEventListener("beforeunload", saveState);

export function setOpenedModule(moduleId: string | null) {
  if (appStore.state.openedModuleId === moduleId) return;
  appStore.setState((state) => ({
    ...state,
    openedModuleId: moduleId,
    recentModuleIds: moduleId
      ? [
          moduleId,
          ...state.recentModuleIds.filter((id) => id !== moduleId),
        ].slice(0, RECENT_LIMIT)
      : state.recentModuleIds,
  }));
}

export function saveModuleView(moduleId: string, view: ModuleView) {
  appStore.setState((state) => ({
    ...state,
    viewByModule: { ...state.viewByModule, [moduleId]: view },
  }));
}

// Drop only presentation state; note content and recent destinations are separate.
export function clearModuleView(moduleId: string) {
  appStore.setState((state) => {
    const { [moduleId]: _, ...viewByModule } = state.viewByModule;
    return { ...state, viewByModule };
  });
  saveState();
}

export function forgetModule(moduleId: string) {
  appStore.setState((state) => {
    const { [moduleId]: _, ...viewByModule } = state.viewByModule;
    return {
      ...state,
      openedModuleId:
        state.openedModuleId === moduleId ? null : state.openedModuleId,
      viewByModule,
      recentModuleIds: state.recentModuleIds.filter((id) => id !== moduleId),
    };
  });
}

export function setSidebarOpen(open: boolean) {
  appStore.setState((state) => ({ ...state, sidebarOpen: open }));
}

export function setLearnAhead(learnAhead: boolean) {
  appStore.setState((state) => ({ ...state, learnAhead }));
}

export function setSkipCardsCreatedToday(skipCardsCreatedToday: boolean) {
  appStore.setState((state) => ({ ...state, skipCardsCreatedToday }));
}

if (isNativeHost()) {
  void listen<boolean>("skip-cards-created-today", ({ payload }) => {
    if (appStore.state.skipCardsCreatedToday !== payload) setSkipCardsCreatedToday(payload);
  });
}
