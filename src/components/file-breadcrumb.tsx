import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "cn";
import { useSidebar } from "./ui/sidebar";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { Module } from "@/lib/types";
import { useMatchRoute } from "@tanstack/react-router";
import { useEditorState } from "@tiptap/react";
import { getFocusedSectionPath } from "@/lib/section-focus";
import { useActiveEditor } from "@/lib/active-editor-context";
import { Fragment } from "react";
import { useIsFullscreen } from "@/hooks/use-fullscreen";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Button } from "./ui/button";

export function FileBreadcrumb() {
  const { state } = useSidebar();
  const isFullScreen = useIsFullscreen();

  const {
    isPending,
    error,
    data: modules = [],
  } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
  });

  const matchRoute = useMatchRoute();
  const match = matchRoute({ to: "/$moduleId" });
  const moduleId = match ? match.moduleId : null;
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
          state === "collapsed" ? (isFullScreen ? "w-30" : "w-46") : "w-2",
        )}
      />
      {/* Below md the sidebar is a sheet, so always clear the window controls. */}
      <div
        className={cn("shrink-0 md:hidden", isFullScreen ? "w-30" : "w-46")}
      />
      <div className="min-w-0">
        <Breadcrumb>
          <BreadcrumbList>
            {!moduleId ? (
              <BreadcrumbItem>
                <BreadcrumbPage>Home</BreadcrumbPage>
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
                        {moduleTitle}
                      </button>
                    }
                  />
                ) : (
                  <BreadcrumbPage className="font-bold">
                    {moduleTitle}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            )}
            {sectionPath.length > 2 && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <DropdownMenu>
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
                    <DropdownMenuContent align="start">
                      <DropdownMenuGroup>
                        {sectionPath
                          .slice(0, sectionPath.length - 2)
                          .map((crumb) => (
                            <DropdownMenuItem
                              onClick={() =>
                                editor?.commands.showSection(crumb.pos)
                              }
                            >
                              {crumb.title}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
              </>
            )}
            {sectionPath
              .slice(sectionPath.length - 2, sectionPath.length)
              .map((crumb, index) => (
                <Fragment key={crumb.pos}>
                  {index === 0 && !(sectionPath.length > 2) ? (
                    <BreadcrumbSeparator />
                  ) : (
                    <BreadcrumbSeparator>/</BreadcrumbSeparator>
                  )}

                  <BreadcrumbItem>
                    {index === sectionPath.length - 1 ? (
                      <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        render={
                          <button
                            type="button"
                            onClick={() =>
                              editor?.commands.showSection(crumb.pos)
                            }
                          >
                            {crumb.title}
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
