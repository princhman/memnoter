import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NEW_MODULE_EVENT, requestApp } from "@/lib/app-events";
import { appStore, setOpenedModule } from "@/lib/store";
import type { Module } from "@/lib/types";
import { MOD_KEY } from "@/lib/utils";
import appIcon from "../../brand/icon-purple-256.png";

const IS_MAC = MOD_KEY === "⌘";
const ALT = IS_MAC ? "⌥" : "Alt+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

const SHORTCUTS: [keys: string, action: string][] = [
  ["/", "Insert a block"],
  [`${MOD_KEY}N`, "New module"],
  [`${MOD_KEY}F`, "Find in the note"],
  [`${MOD_KEY}K`, "Search notes and commands"],
  [`${MOD_KEY}L`, "Add a link"],
  [`${MOD_KEY}${ALT}S`, "New section"],
  [`${MOD_KEY}${ALT}[ / ${MOD_KEY}${ALT}]`, "Fold and unfold a section"],
  [`${MOD_KEY}${SHIFT}M`, "Inline math"],
  [`${MOD_KEY}D`, "Show or hide the sidebar"],
];

const RECENT_SHOWN = 5;

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
  const { data: modules } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
  });
  const recentIds = useSelector(appStore, (state) => state.recentModuleIds);

  // Recently opened ones first, then the rest in the sidebar's order.
  const byId = new Map(modules?.map((module) => [module.id, module]));
  const recent = [
    ...recentIds.flatMap((id) => byId.get(id) ?? []),
    ...(modules ?? []).filter((module) => !recentIds.includes(module.id)),
  ].slice(0, RECENT_SHOWN);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-8 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        <img src={appIcon} alt="" className="size-16 rounded-2xl" draggable={false} />
        <div>
          <h1 className="font-heading text-2xl font-semibold">Memnoter</h1>
          <p className="text-sm text-muted-foreground">
            {modules?.length
              ? "Pick up where you left off, or start something new."
              : "Create your first module to start taking notes."}
          </p>
        </div>
        <Button onClick={() => requestApp(NEW_MODULE_EVENT)}>
          <Plus />
          New module
        </Button>
      </div>

      {recent.length > 0 && (
        <section aria-labelledby="recent-modules" className="w-full text-left">
          <h2
            id="recent-modules"
            className="px-2 pb-1 text-xs font-medium text-muted-foreground"
          >
            Recent
          </h2>
          <ul className="grid gap-0.5">
            {recent.map((module) => (
              <li key={module.id}>
                <Link
                  to="/$moduleId"
                  params={{ moduleId: module.id }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{module.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="shortcuts" className="w-full text-left">
        <h2
          id="shortcuts"
          className="px-2 pb-1 text-xs font-medium text-muted-foreground"
        >
          Shortcuts
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-2 text-sm">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={action} className="contents">
              <dt>
                <kbd className="font-sans text-xs text-muted-foreground">
                  {keys}
                </kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
