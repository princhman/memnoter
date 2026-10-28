import { appStore } from "@/lib/store";

// Most recently opened modules first, for the palette's empty state.
const STORAGE_KEY = "recent-modules";
const MAX_RECENT = 20;

function load(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

let recent = load();

function remember(moduleId: string | null) {
  if (!moduleId || recent[0] === moduleId) return;
  recent = [moduleId, ...recent.filter((id) => id !== moduleId)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch (error) {
    console.error("Failed to save recent modules:", error);
  }
}

remember(appStore.state.openedModuleId);
appStore.subscribe(() => remember(appStore.state.openedModuleId));

export function getRecentModuleIds() {
  return recent;
}
