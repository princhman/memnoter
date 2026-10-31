import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { TOGGLE_SIDEBAR_EVENT } from "@/lib/app-events";
import { Module } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import CreateModule from "./create-module";
import { Ellipsis, House, Pencil, Settings, Trash2 } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import { useDueCounts } from "@/lib/card-sync";

const ModuleMenu = ({ name, moduleId }: { name: string; moduleId: string }) => {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction showOnHover aria-label={`Actions for ${name}`} />
          }
        >
          <Ellipsis />
        </DropdownMenuTrigger>

        <DropdownMenuContent>
          <DropdownMenuGroup>
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
    </>
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
      <SidebarContent className="pt-6">
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={!!matchRoute({ to: "/" })}
                render={<Link to="/" />}
              >
                <House />
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link to="/review" search={{}} />}>
                <span>Review ({total} due)</span>
              </SidebarMenuButton>
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
                    <SidebarMenuItem key={module.id}>
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
                      <ModuleMenu moduleId={module.id} name={module.name} />
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UpdateStatus>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground aria-[current=page]:text-foreground"
                  aria-label="Settings"
                  render={<Link to="/settings" />}
                />
              }
            >
              <Settings />
            </TooltipTrigger>
            <TooltipContent side="top">Settings</TooltipContent>
          </Tooltip>
        </UpdateStatus>
      </SidebarFooter>
    </Sidebar>
  );
};

export default AppSidebar;
