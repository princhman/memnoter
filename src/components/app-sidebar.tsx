import { MOD_KEY } from "@/lib/utils";
import { openReview } from "@/lib/card-sync";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { TOGGLE_SIDEBAR_EVENT } from "@/lib/app-events";
import { Module } from "@/lib/types";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { call as invoke } from "../lib/backend.ts";
import CreateModule from "./create-module";
import { Ellipsis, House, Layers, Pencil, Settings, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import RenameModule from "./rename-module";
import DeleteModule from "./delete-module";
import UpdateStatus from "./update-status";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { useDueCounts } from "@/lib/card-sync";
import { CardCounts } from "@/components/card-counts";

const ModuleMenu = ({ name, moduleId, numbered, children }: { name: string; moduleId: string; numbered: boolean; children: ReactNode }) => {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const showMenu = () => { trigger.current?.focus(); setMenuOpen(true); };
  const client = useQueryClient();
  const numbering = useMutation({
    mutationFn: (enabled: boolean) => invoke("set_module_numbering", { moduleId, enabled }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["modules"] }),
  });
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <SidebarMenuItem
      onContextMenu={event => { event.preventDefault(); showMenu(); }}
      onKeyDown={event => {
        if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
          event.preventDefault(); showMenu();
        }
      }}
    >
      {children}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <IconTooltip label={`Actions for ${name}`} hint="Shift+F10" side="right">
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction ref={trigger} showOnHover aria-label={`Actions for ${name}`} />
          }
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        </IconTooltip>

        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => void openReview(() => navigate({ to: "/review", search: { module: moduleId } }))}>
              <Layers className="size-3" />Review
            </DropdownMenuItem>
            <DropdownMenuItem disabled={numbering.isPending} onClick={() => numbering.mutate(!numbered)}>
              {numbered ? "Disable" : "Enable"} chapter numbering
            </DropdownMenuItem>
            {numbering.isError && <div role="alert">{numbering.error.message}</div>}
            <DropdownMenuItem onClick={() => setRenameOpen(true)}>
              <Pencil className="size-3" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-3" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameModule
        moduleName={name}
        moduleId={moduleId}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <DeleteModule
        moduleName={name}
        moduleId={moduleId}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </SidebarMenuItem>
  );
};

const AppSidebar = () => {
  const { isPending, error, data } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
  });
  const matchRoute = useMatchRoute();
  const { total } = useDueCounts();

  // Narrow windows show the sidebar as a sheet with its own open state.
  const { toggleSidebar } = useSidebar();
  useEffect(() => {
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, toggleSidebar);
    return () => window.removeEventListener(TOGGLE_SIDEBAR_EVENT, toggleSidebar);
  }, [toggleSidebar]);

  return (
    <Sidebar>
      <div data-tauri-drag-region="deep" className="h-8 shrink-0" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={!!matchRoute({ to: "/" })}
                render={<Link to="/" />}
              >
                <House />
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={!!matchRoute({ to: "/review" })}
                render={<Link to="/review" search={{}} />}
              >
                <Layers />
                <span>Review</span>
              </SidebarMenuButton>
              <SidebarMenuBadge>
                <CardCounts counts={total} />
              </SidebarMenuBadge>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Modules</SidebarGroupLabel>
          <CreateModule />

          {isPending && <div>Loading...</div>}
          {error && <div>Error: {error.message}</div>}

          {data && (
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {data.map((module) => {
                  const isActive = !!matchRoute({
                    to: "/$moduleId",
                    params: { moduleId: module.id },
                    fuzzy: true,
                  });
                  return (
                    <ModuleMenu key={module.id} moduleId={module.id} name={module.name} numbered={module.heading_numbering}>
                      <SidebarMenuButton
                        isActive={isActive}
                        render={
                          <Link
                            to="/$moduleId"
                            params={{ moduleId: module.id }}
                          />
                        }
                      >
                        <span>{module.name}</span>
                      </SidebarMenuButton>
                    </ModuleMenu>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UpdateStatus>
          <IconTooltip label="Settings" hint={`${MOD_KEY},`} side="top">
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground aria-[current=page]:text-foreground" aria-label="Settings" render={<Link to="/settings" />}><Settings /></Button>
          </IconTooltip>
        </UpdateStatus>
      </SidebarFooter>
    </Sidebar>
  );
};

export default AppSidebar;
