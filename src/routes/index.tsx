import { createFileRoute, redirect } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { appStore, setOpenedModule } from "@/lib/store";
import type { Module } from "@/lib/types";

// Reopen the last module only on launch; later visits to "/" are deliberate.
let hasRestoredModule = false;

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (hasRestoredModule) return;
    hasRestoredModule = true;

    const moduleId = appStore.state.openedModuleId;
    if (!moduleId) return;

    const modules = await invoke<Module[]>("modules").catch(() => []);
    if (!modules.some((module) => module.id === moduleId)) {
      setOpenedModule(null);
      return;
    }

    throw redirect({ to: "/$moduleId", params: { moduleId }, replace: true });
  },
  component: Index,
});

function Index() {
  return <div className="card">Choose module</div>;
}
