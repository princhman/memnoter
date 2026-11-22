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
import { Link, useMatchRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { SidebarModules } from "./sidebar-modules";
import { ChevronRight, Ellipsis, FilePlus, FileText, House, Files, CircleHelp, Layers, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { addSidebarSection, openSidebarSection, SidebarSectionNavigation, useSidebarSections } from "@/lib/sidebar-sections";
import type { Module } from "@/lib/types";
import { useSelector } from "@tanstack/react-store";
import { appStore } from "@/lib/store";
import { useActiveEditor } from "@/lib/active-editor-context";
import { reorderSidebarSection } from "@/lib/section-reorder";
import { SidebarSectionRow } from "./sidebar-section-row";
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
  const router = useRouter();
  const sidebarSections = useSelector(appStore, state => state.sidebarSections);
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const showMenu = () => { trigger.current?.focus(); setMenuOpen(true); };
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Shared by the pointer-positioned context menu and the "…" dropdown.
  const items = (Item: typeof DropdownMenuItem | typeof ContextMenuItem) => (
    <>
      {sidebarSections && <Item onClick={() => {
        addSidebarSection(moduleId, router);
      }}><Plus className="size-3" />Add section</Item>}
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

function ModuleEntry({ module, isActive }: { module: Module; isActive: boolean }) {
  const [expanded, setExpanded] = useState(isActive);
  const { sections, focusedKey, canReorder, loading, error } = useSidebarSections(module.id, expanded);
  const navigate = useNavigate();
  const sectionsId = `sidebar-sections-${module.id}`;
  useEffect(() => { if (isActive) setExpanded(true); }, [isActive]);

  return <ModuleMenu moduleId={module.id} name={module.name}>
    <div className="relative">
    <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} sections of ${module.name}`}
      aria-expanded={expanded} aria-controls={expanded ? sectionsId : undefined}
      className="absolute top-1 left-0 z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onPointerDown={event => event.stopPropagation()}
      onClick={() => setExpanded(value => !value)}>
      <ChevronRight className={`size-3.5 ${expanded ? "rotate-90" : ""}`} />
    </button>
    <SidebarMenuButton className="pl-7" isActive={isActive && !focusedKey}
      render={<Link to="/$moduleId" params={{ moduleId: module.id }} />}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        openSidebarSection(module.id, { kind: "document" });
      }}>
      <MiddleTruncate text={module.name} />
    </SidebarMenuButton>
    </div>
    {expanded && <ul id={sectionsId} aria-label={`Sections of ${module.name}`} className="mt-0.5 space-y-0.5 pl-5"
      onPointerDown={event => event.stopPropagation()}>
      {loading && <li className="px-2 py-1 text-xs text-muted-foreground" role="status">Loading sections…</li>}
      {error && <li className="px-2 py-1 text-xs text-muted-foreground" role="alert">Could not load sections.</li>}
      {!loading && !error && !sections.length && <li className="px-2 py-1 text-xs text-muted-foreground">No H1 sections</li>}
      {sections.map(section => <SidebarSectionRow key={section.key}
          moduleId={module.id} headingId={section.target.kind === "heading" ? section.target.id : null} title={section.title}
          number={module.heading_numbering ? section.number : undefined}
          selected={isActive && focusedKey === section.key} canReorder={canReorder}
          onClick={() => {
            openSidebarSection(module.id, section.target);
            void navigate({ to: "/$moduleId", params: { moduleId: module.id } });
          }}
        />)}
    </ul>}
  </ModuleMenu>;
}

const AppSidebar = () => {
  const { isPending, error, data } = useModules();
  const matchRoute = useMatchRoute();
  const { total } = useDueCounts();
  const sidebarSections = useSelector(appStore, state => state.sidebarSections);
  const { activeEditor } = useActiveEditor();
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
      {sidebarSections && <SidebarSectionNavigation />}
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
              <SidebarModules modules={data} onReorderSection={sidebarSections ? move => reorderSidebarSection(move, activeEditor) : undefined} renderModule={(module, preview) => {
                  const isActive = moduleId === module.id;
                  return sidebarSections && !preview
                    ? <ModuleEntry key={module.id} module={module} isActive={isActive} />
                    : <ModuleMenu key={module.id} moduleId={module.id} name={module.name}>
                      <SidebarMenuButton isActive={isActive} render={<Link to="/$moduleId" params={{ moduleId: module.id }} />}>
                        <MiddleTruncate text={module.name} />
                      </SidebarMenuButton>
                    </ModuleMenu>;
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
