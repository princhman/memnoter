import { useCallback, type ReactElement } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronDown, FileText, Files, CircleHelp, Layers, MoveDiagonal2 } from "lucide-react";
import { openReview } from "./card-navigation-guard";
import { useBankGate } from "@/lib/question-bank";
import { appStore, setModulePage } from "@/lib/store";
import { updatePdfPane } from "@/lib/pdf-pane";
import { useOpenModuleId } from "@/lib/open-module";
import { useDocuments } from "@/lib/use-documents";
import { action, formatKeys } from "@/lib/shortcuts";
import { IconTooltip } from "./ui/icon-tooltip";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

export type ModuleSection = "notes" | "files" | "questions" | "review";

// Shared pages retain their explicit scope, including All modules. A PDF
// reader inherits its document's module rather than the last note's module.
export function useModuleSectionScope() {
  const moduleId = useOpenModuleId();
  const location = useRouterState({ select: state => state.location });
  const { data: documents = [] } = useDocuments();
  const readerId = location.pathname.match(/^\/files\/([^/]+)\/?$/)?.[1];
  if (readerId) return documents.find(doc => doc.id === decodeURIComponent(readerId))?.moduleId;
  if (/^\/(files|questions|review)\/?$/.test(location.pathname)) {
    const scope = (location.search as { module?: unknown }).module;
    return typeof scope === "string" ? scope : undefined;
  }
  return moduleId;
}

// Both header menus, sidebar and keyboard use the same navigation/guards.
export function useModuleSectionNavigation() {
  const navigate = useNavigate();
  const openModuleId = useOpenModuleId();
  const bankEnabled = useBankGate();
  return useCallback(async (section: ModuleSection, moduleId?: string, options: { sharedQuestions?: boolean } = {}) => {
    if (section === "review") {
      await openReview(() => navigate({ to: "/review", search: moduleId ? { module: moduleId } : {} }));
    } else if (section === "files") {
      await navigate({ to: "/files", search: moduleId ? { module: moduleId } : {} });
    } else if (section === "questions") {
      if (!bankEnabled) return;
      if (moduleId) setModulePage(moduleId, "questions");
      if (openModuleId && moduleId && !options.sharedQuestions) {
        updatePdfPane(moduleId, { open: true });
        await navigate({ to: "/$moduleId", params: { moduleId } });
      } else {
        await navigate({ to: "/questions", search: moduleId ? { module: moduleId } : {} });
      }
    } else {
      const notesModule = moduleId ?? appStore.state.openedModuleId ?? appStore.state.recentModuleIds[0];
      if (notesModule) {
        setModulePage(notesModule, "notes");
        await navigate({ to: "/$moduleId", params: { moduleId: notesModule } });
      } else {
        await navigate({ to: "/" });
      }
    }
  }, [navigate, openModuleId, bankEnabled]);
}

export function SectionTooltip({ section, children, allModules = false }: { section: ModuleSection; children: ReactElement; allModules?: boolean }) {
  const label = { notes: "Notes", files: "Files", questions: "Questions", review: "Review" }[section];
  const keys = action(allModules && section !== "notes" ? `navigation.all.${section}` : `navigation.${section}`).keys;
  return <IconTooltip label={label} hint={formatKeys(keys)} side="right">{children}</IconTooltip>;
}

export function ModuleSectionMenu({ page, moduleId, onNotes, onWholeNote }: {
  page: ModuleSection;
  moduleId?: string;
  onNotes?: () => void;
  onWholeNote?: () => void;
}) {
  const bankEnabled = useBankGate();
  const navigateSection = useModuleSectionNavigation();
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="inline-flex! min-w-0 gap-2 px-1.5 text-sm" aria-label="Select module section" />}>
      {{ notes: "Notes", files: "Files", questions: "Questions", review: "Review" }[page]}<ChevronDown className="size-3 shrink-0" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-56">
      <DropdownMenuRadioGroup className="space-y-1 p-0.5" value={page} onValueChange={value => { void navigateSection(value as ModuleSection, moduleId); }}>
        <SectionTooltip section="notes"><DropdownMenuRadioItem value="notes" showIndicator={false} closeOnClick onClick={() => { if (page === "notes") onNotes?.(); }}><FileText aria-hidden="true" />Notes</DropdownMenuRadioItem></SectionTooltip>
        <SectionTooltip section="files"><DropdownMenuRadioItem value="files" showIndicator={false} closeOnClick onClick={() => { if (page === "files") void navigateSection("files", moduleId); }}><Files aria-hidden="true" />Files</DropdownMenuRadioItem></SectionTooltip>
        {bankEnabled && <SectionTooltip section="questions"><DropdownMenuRadioItem value="questions" showIndicator={false} closeOnClick><CircleHelp aria-hidden="true" />Questions</DropdownMenuRadioItem></SectionTooltip>}
        <SectionTooltip section="review"><DropdownMenuRadioItem value="review" showIndicator={false} closeOnClick><Layers aria-hidden="true" />Review</DropdownMenuRadioItem></SectionTooltip>
      </DropdownMenuRadioGroup>
      {onWholeNote && <>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="m-0.5" onClick={onWholeNote}>
          <MoveDiagonal2 aria-hidden="true" />Whole Note
        </DropdownMenuItem>
      </>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
