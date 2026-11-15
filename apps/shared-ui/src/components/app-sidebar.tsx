import { useBankGate } from "@/lib/question-bank";
import { SectionTooltip, useModuleSectionNavigation, useModuleSectionScope, type ModuleSection } from "./module-section-menu";
import { MiddleTruncate } from "./middle-truncate";
import { action, formatKeys } from "@/lib/shortcuts";
import { useModules } from "@/lib/modules";
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
import { Link, useMatchRoute } from "@tanstack/react-router";
import { SidebarModules } from "./sidebar-modules";
import { Ellipsis, FilePlus, FileText, House, Files, CircleHelp, Layers, Pencil, Settings, Trash2 } from "lucide-react";
import { pickPdfs } from "./add-pdf";
import { isTauri } from "@/lib/backend";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import RenameModule from "./rename-module";
import DeleteModule from "./delete-module";
import UpdateStatus from "./update-status";
import { BetaBadge } from "./beta-notice";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { useDueCounts } from "@/lib/card-sync";
import { CardCounts } from "@/components/card-counts";

const ModuleMenu = ({ name, moduleId, children }: { name: string; moduleId: string; children: ReactNode }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const showMenu = () => { trigger.current?.focus(); setMenuOpen(true); };
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Shared by the pointer-positioned context menu and the "…" dropdown.
  const items = (Item: typeof DropdownMenuItem | typeof ContextMenuItem) => (
    <>
      {isTauri() && <Item onClick={() => pickPdfs(moduleId)}><FilePlus className="size-3" />Add PDF…</Item>}
      <Item onClick={() => setRenameOpen(true)}>
        <Pencil className="size-3" />
        Rename
      </Item>
      <Item variant="destructive" onClick={() => setDeleteOpen(true)}>
        <Trash2 className="size-3" />
        Delete
      </Item>
    </>
  );

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger
        render={<SidebarMenuItem
          onKeyDown={event => {
            // The keyboard has no pointer position, so open the "…" menu instead.
            if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
              event.preventDefault(); showMenu();
            }
          }}
        />}
      >
        {children}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction ref={trigger} showOnHover aria-label={`Actions for ${name}`} />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>

          <DropdownMenuContent>
            <DropdownMenuGroup>{items(DropdownMenuItem)}</DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>{items(ContextMenuItem)}</ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
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
  const { isPending, error, data } = useModules();
  const matchRoute = useMatchRoute();
  const { total } = useDueCounts();
  const bankEnabled = useBankGate();
  const moduleId = useModuleSectionScope();
  const navigateSection = useModuleSectionNavigation();
  const sections: { id: ModuleSection; label: string; icon: typeof FileText; active: boolean }[] = [
    { id: "files", label: "Files", icon: Files, active: !moduleId && !!matchRoute({ to: "/files" }) },
    ...(bankEnabled ? [{ id: "questions" as const, label: "Questions", icon: CircleHelp, active: !moduleId && !!matchRoute({ to: "/questions" }) }] : []),
    { id: "review", label: "Review", icon: Layers, active: !moduleId && !!matchRoute({ to: "/review" }) },
  ];

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
            {sections.map(section => <SidebarMenuItem key={section.id}>
              <SectionTooltip section={section.id} allModules><SidebarMenuButton isActive={section.active} onClick={() => void navigateSection(section.id, undefined, { sharedQuestions: true })}>
                <section.icon /><span>{section.label}</span>
                {section.id === "review" && <CardCounts className="ml-auto" counts={total} />}
              </SidebarMenuButton></SectionTooltip>
            </SidebarMenuItem>)}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Modules</SidebarGroupLabel>

          {isPending && <div>Loading...</div>}
          {error && <div>Error: {error.message}</div>}

          {data && (
            <SidebarGroupContent>
              <SidebarModules modules={data} renderModule={(module) => {
                  const isActive = moduleId === module.id;
                  return (
                    <ModuleMenu key={module.id} moduleId={module.id} name={module.name}>
                      <SidebarMenuButton
                        isActive={isActive}
                        render={
                          <Link
                            to="/$moduleId"
                            params={{ moduleId: module.id }}
                          />
                        }
                      >
                        <MiddleTruncate text={module.name} />
                      </SidebarMenuButton>
                    </ModuleMenu>
                  );
                }} />
            </SidebarGroupContent>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UpdateStatus>
          <BetaBadge />
          <IconTooltip label="Settings" hint={formatKeys(action("settings.open").keys)} side="top">
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground aria-[current=page]:text-foreground" aria-label="Settings" render={<Link to="/settings" />}><Settings /></Button>
          </IconTooltip>
        </UpdateStatus>
      </SidebarFooter>
    </Sidebar>
  );
};

export default AppSidebar;
