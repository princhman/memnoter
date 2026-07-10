import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Module } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import CreateModule from "./create-module";

export function AppSidebar() {
  const { isPending, error, data } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
  });
  const matchRoute = useMatchRoute();

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex justify-between">
          <div className="px-2 py-1 text-sm font-semibold pt-8">Notes</div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <span>Home</span>
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
              <SidebarMenu>
                {data.map((module) => {
                  const isActive = !!matchRoute({
                    to: "/$moduleId",
                    params: { moduleId: module.id },
                    fuzzy: true,
                  });
                  return (
                    <Link to="/$moduleId" params={{ moduleId: module.id }}>
                      <SidebarMenuItem>
                        <SidebarMenuButton isActive={isActive}>
                          <span>{module.name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </Link>
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
}
