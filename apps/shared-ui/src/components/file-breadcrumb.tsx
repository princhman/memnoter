import { MiddleTruncate } from "./middle-truncate";
import { HeadingTitle } from "./table-of-contents";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useAnyWorksheetOpen, WORKSHEET_CRUMB_SLOT } from "@/lib/pdf-pane";
import { useDocuments } from "@/lib/use-documents";
import { documentName } from "@/lib/pdf-state";
import { useModulePage } from "@/lib/store";
import { useBankGate } from "@/lib/question-bank";
import { IconTooltip } from "@/components/icon-tooltip";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { useSidebar } from "./ui/sidebar";
import { useMatchRoute, useSearch } from "@tanstack/react-router";
import { useEditorState } from "@tiptap/react";
import { getFocusedSectionPath } from "@/lib/section-focus";
import { useActiveEditor } from "@/lib/active-editor-context";
import { Fragment } from "react";
import { ReviewScopeMenu } from "./review-scope-menu";
import { ModuleSectionMenu, type ModuleSection } from "./module-section-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Button } from "./ui/button";

// Clears the window controls and toolbar, whose width the root layout sets.
const TOOLBAR_OFFSET = "w-[calc(var(--toolbar-width,10.75rem)+0.75rem)]";

function SectionTitle({ title, node }: { title: string; node: PMNode | null }) {
  if (node?.children.some(child => child.type.name === "inlineMath")) {
    return <span className="block truncate" title={title}><HeadingTitle node={node} /></span>;
  }
  return <MiddleTruncate text={title} />;
}

export function FileBreadcrumb() {
  const { state } = useSidebar();

  const matchRoute = useMatchRoute();
  const search = useSearch({ strict: false });
  // These pages also match the module id pattern.
  const isSettings = !!matchRoute({ to: "/settings" });
  const isQuestions = !!matchRoute({ to: "/questions" });
  const isReview = !!matchRoute({ to: "/review" });
  const isFiles = !!matchRoute({ to: "/files", fuzzy: true });
  const reader = matchRoute({ to: "/files/$documentId" });
  const { data: documents = [] } = useDocuments();
  const pdf = reader ? documents.find(doc => doc.id === reader.documentId) : undefined;
  const match = matchRoute({ to: "/$moduleId" });
  const moduleId = match && !isSettings && !isReview && !isFiles && !isQuestions ? match.moduleId : null;
  const modulePage = useModulePage(moduleId);
  const bankEnabled = useBankGate();
  const page: ModuleSection = isQuestions ? "questions" : isFiles ? "files" : isReview ? "review" : bankEnabled && modulePage === "questions" ? "questions" : "notes";
  const scopedModuleId = moduleId ?? pdf?.moduleId ?? ((isFiles || isReview || isQuestions) ? search.module : undefined);
  const { activeEditor } = useActiveEditor();
  // An open worksheet replaces the crumbs with its own back button and title, as on iPad.
  const worksheet = useAnyWorksheetOpen() !== null && page === "questions";
  const editor =
    page === "notes" && activeEditor?.moduleId === moduleId ? activeEditor.editor : null;

  const sectionPath =
    useEditorState({
      editor,
      selector: ({ editor }) => editor ? getFocusedSectionPath(editor).map(crumb => ({
        ...crumb,
        node: editor.state.doc.nodeAt(crumb.pos),
      })) : [],
      equalityFn: (previous, next) => {
        if (previous === next) return true;
        if (!previous || !next) return false;
        return (
          previous.length === next.length &&
          previous.every(
            (crumb, index) =>
              crumb.pos === next[index].pos &&
              crumb.node === next[index].node,
          )
        );
      },
    }) ?? [];

  return (
    <>
      <div
        // Keep the offset in layout, alongside the sidebar gap. A separate
        // translate can advance ahead of layout and briefly reverse the motion.
        // Only shown from md up, like the sidebar gap, so it only eases on
        // sidebar toggles and swaps instantly when crossing the breakpoint.
        className={cn(
          "hidden shrink-0 transition-[width] duration-(--sidebar-motion-duration) ease-(--sidebar-motion-ease) motion-reduce:transition-none md:block",
          state === "collapsed" ? TOOLBAR_OFFSET : "w-2",
        )}
      />
      {/* Below md the sidebar is a sheet, so always clear the window controls. */}
      <div className={cn("shrink-0 md:hidden", TOOLBAR_OFFSET)} />
      <div id={WORKSHEET_CRUMB_SLOT} className="flex min-w-0 items-center empty:hidden" />
      <div className={cn("min-w-0 overflow-hidden", worksheet && "hidden")}>
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap whitespace-nowrap [&>[data-slot=breadcrumb-item]]:min-w-0 [&>[data-slot=breadcrumb-item]]:overflow-hidden [&>[data-slot=breadcrumb-item]>*]:block [&>[data-slot=breadcrumb-item]>*]:overflow-hidden [&>[data-slot=breadcrumb-item]>*]:min-w-0 [&>[data-slot=breadcrumb-item]>*]:max-w-full [&>[data-slot=breadcrumb-separator]]:shrink-0">
            {moduleId || isFiles || isReview || isQuestions ? (
              <>
                <BreadcrumbItem className="shrink-0 overflow-visible!">
                  <ReviewScopeMenu page={page} current={scopedModuleId} />
                </BreadcrumbItem>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem className="shrink-0 overflow-visible!">
                  <ModuleSectionMenu page={page} moduleId={scopedModuleId} onNotes={() => editor?.commands.showDocument()} />
                </BreadcrumbItem>
                {pdf && <>
                  <BreadcrumbSeparator>›</BreadcrumbSeparator>
                  <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate whitespace-nowrap"><MiddleTruncate text={documentName(pdf.name)} /></BreadcrumbPage></BreadcrumbItem>
                </>}
              </>
            ) : (
              <BreadcrumbItem className="shrink-0">
                <BreadcrumbPage data-tauri-drag-region="deep">{isSettings ? "Settings" : "Home"}</BreadcrumbPage>
              </BreadcrumbItem>
            )}
            {sectionPath.length > 2 && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <DropdownMenu>
                    <IconTooltip label="Show parent sections">
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Show parent sections"
                        >
                          <BreadcrumbEllipsis />
                        </Button>
                      }
                    />
                    </IconTooltip>
                    <DropdownMenuContent align="start">
                      <DropdownMenuGroup>
                        {sectionPath
                          .slice(0, sectionPath.length - 2)
                          .map((crumb) => (
                            <DropdownMenuItem
                              key={crumb.pos}
                              onClick={() =>
                                editor?.commands.showSection(crumb.pos)
                              }
                            >
                              <SectionTitle title={crumb.title} node={crumb.node} />
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
              </>
            )}
            {sectionPath
              .slice(-2)
              .map((crumb, index) => (
                <Fragment key={crumb.pos}>
                  {index === 0 && !(sectionPath.length > 2) ? (
                    <BreadcrumbSeparator />
                  ) : (
                    <BreadcrumbSeparator>/</BreadcrumbSeparator>
                  )}

                  <BreadcrumbItem>
                    {index === Math.min(2, sectionPath.length) - 1 ? (
                      <BreadcrumbPage data-tauri-drag-region="deep"><SectionTitle title={crumb.title} node={crumb.node} /></BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        render={
                          <button
                            type="button"
                            onClick={() =>
                              editor?.commands.showSection(crumb.pos)
                            }
                          >
                            <SectionTitle title={crumb.title} node={crumb.node} />
                          </button>
                        }
                      />
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </>
  );
}

