import { appStore } from "@/lib/store";

export function getRecentModuleIds() {
  return appStore.state.recentModuleIds;
}
