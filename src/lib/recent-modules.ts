import { appStore } from "@/lib/store";

// Shared with the welcome screen and pruned when a module is deleted.
export function getRecentModuleIds() {
  return appStore.state.recentModuleIds;
}
