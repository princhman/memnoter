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
} from "@/components/ui/sidebar";
import { Module } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import CreateModule from "./create-module";
import { Ellipsis, Pencil } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import RenameModule from "./rename-module";
import { useState } from "react";

const ModuleMenu = ({ name, moduleId }: { name: string; moduleId: string }) => {
  const [renameOpen, setRenameOpen] = useState(false);

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
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameModule
        moduleName={name}
        moduleId={moduleId}
        open={renameOpen}
        onOpenChange={setRenameOpen}
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

  return (
    <Sidebar>
      <SidebarContent className="pt-6">
        {/*<SidebarHeader>
        <div className="flex justify-between">
          <div className="px-2 text-md font-semibold pt-8">Notes</div>
        </div>
      </SidebarHeader>

        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>*/}
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
                    <SidebarMenuItem>
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

      <SidebarFooter />
    </Sidebar>
  );
};

export default AppSidebar;
