import { MiddleTruncate } from "./middle-truncate";
import { useDocuments } from "@/lib/use-documents";
import { documentName } from "@/lib/pdf-state";
import { useModules } from "@/lib/modules";
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
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useEditorState } from "@tiptap/react";
import { getFocusedSectionPath } from "@/lib/section-focus";
import { useActiveEditor } from "@/lib/active-editor-context";
import { Fragment } from "react";
import { ReviewScopeMenu } from "./review-scope-menu";
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

export function FileBreadcrumb() {
  const { state } = useSidebar();

  const {
    isPending,
    error,
    data: modules = [],
  } = useModules();

  const matchRoute = useMatchRoute();
  // These pages also match the module id pattern.
  const isSettings = !!matchRoute({ to: "/settings" });
  const isReview = !!matchRoute({ to: "/review" });
  const isFiles = !!matchRoute({ to: "/files", fuzzy: true });
  const reader = matchRoute({ to: "/files/$documentId" });
  const { data: documents = [] } = useDocuments();
  const pdf = reader ? documents.find(doc => doc.id === reader.documentId) : undefined;
  const match = matchRoute({ to: "/$moduleId" });
  const moduleId = match && !isSettings && !isReview && !isFiles ? match.moduleId : null;
  const moduleName = modules.find((module) => module.id === moduleId)?.name;
  const { activeEditor } = useActiveEditor();
  const editor =
    activeEditor?.moduleId === moduleId ? activeEditor.editor : null;

  const sectionPath =
    useEditorState({
      editor,
      selector: ({ editor }) => (editor ? getFocusedSectionPath(editor) : []),
      equalityFn: (previous, next) => {
        if (previous === next) return true;
        if (!previous || !next) return false;
        return (
          previous.length === next.length &&
          previous.every(
            (crumb, index) =>
              crumb.pos === next[index].pos &&
              crumb.title === next[index].title,
          )
        );
      },
    }) ?? [];

  const moduleTitle =
    moduleName ??
    (isPending ? "Loading..." : error ? "Module unavailable" : moduleId);

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
      <div className="min-w-0 overflow-hidden">
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap whitespace-nowrap [&>[data-slot=breadcrumb-item]]:min-w-0 [&>[data-slot=breadcrumb-item]]:overflow-hidden [&>[data-slot=breadcrumb-item]>*]:block [&>[data-slot=breadcrumb-item]>*]:overflow-hidden [&>[data-slot=breadcrumb-item]>*]:min-w-0 [&>[data-slot=breadcrumb-item]>*]:max-w-full [&>[data-slot=breadcrumb-separator]]:shrink-0">
            {isFiles ? (<>
              {/* Like Review: the module scope first, then the page. */}
              <BreadcrumbItem className="min-w-0 overflow-visible!"><ReviewScopeMenu page="files" current={pdf?.moduleId} /></BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              {pdf ? <>
                <BreadcrumbItem className="shrink-0"><BreadcrumbLink render={<Link to="/files" search={{ module: pdf.moduleId }} />}>Files</BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator>›</BreadcrumbSeparator>
                <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate whitespace-nowrap"><MiddleTruncate text={documentName(pdf.name)} /></BreadcrumbPage></BreadcrumbItem>
              </> : <BreadcrumbItem className="shrink-0"><BreadcrumbPage data-tauri-drag-region="deep">Files</BreadcrumbPage></BreadcrumbItem>}
            </>) : isReview ? (
              <>
                {/* The module under review comes first, as it will for a module's other pages. */}
                <BreadcrumbItem className="min-w-0 overflow-visible!">
                  <ReviewScopeMenu />
                </BreadcrumbItem>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbPage data-tauri-drag-region="deep">Review</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : !moduleId ? (
              <BreadcrumbItem className="shrink-0">
                <BreadcrumbPage data-tauri-drag-region="deep">{isSettings ? "Settings" : "Home"}</BreadcrumbPage>
              </BreadcrumbItem>
            ) : (
              <BreadcrumbItem>
                {sectionPath.length ? (
                  <BreadcrumbLink
                    className="font-bold"
                    render={
                      <button
                        type="button"
                        onClick={() => editor?.commands.showDocument()}
                      >
                        <MiddleTruncate text={moduleTitle ?? ""} />
                      </button>
                    }
                  />
                ) : (
                  <BreadcrumbPage data-tauri-drag-region="deep" className="font-bold">
                    <MiddleTruncate text={moduleTitle ?? ""} />
                  </BreadcrumbPage>
                )}
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
                              <MiddleTruncate text={crumb.title} />
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
                      <BreadcrumbPage data-tauri-drag-region="deep"><MiddleTruncate text={crumb.title} /></BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        render={
                          <button
                            type="button"
                            onClick={() =>
                              editor?.commands.showSection(crumb.pos)
                            }
                          >
                            <MiddleTruncate text={crumb.title} />
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

