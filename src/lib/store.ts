import { createStore } from "@tanstack/react-store";

type appState = {
  openedModuleId: string | null;
  focusedSectionByModule: Record<string, number | null>;
};

const defaultState: appState = {
  openedModuleId: null,
  focusedSectionByModule: {},
};

function loadState(): appState {
  try {
    const saved = localStorage.getItem("app-state");
    return saved ? JSON.parse(saved) : defaultState;
  } catch {
    return defaultState;
  }
}

export const appStore = createStore(loadState());

appStore.subscribe(() => {
  localStorage.setItem("app-state", JSON.stringify(appStore.state));
});
