import { useMatchRoute, useRouterState } from "@tanstack/react-router";
import { PanelRight, Plus } from "lucide-react";
import { useDocuments } from "@/lib/use-documents";
import { updatePdfPane, usePdfPane } from "@/lib/pdf-pane";
import { isTauri } from "@/lib/backend";
import { pickPdfs } from "./add-pdf";
import { Button } from "./ui/button";
import { ToolButton } from "./ui/tool-button";

// The reader portals its page and zoom controls here, at the right end of the
// header, so they never run into the breadcrumbs.
export const PDF_TOOLBAR_ID = "pdf-toolbar";

function NotePdfToggle({ moduleId }: { moduleId: string }) {
  const { data: docs = [] } = useDocuments(moduleId);
  const pane = usePdfPane(moduleId);
  if (!docs.length) return null;
  return <ToolButton label={pane.open ? "Hide PDFs" : "Show PDFs beside note"} pressed={pane.open}
    onClick={() => updatePdfPane(moduleId, { open: !pane.open })}><PanelRight /></ToolButton>;
}

export function PdfHeaderActions() {
  const matchRoute = useMatchRoute();
  const files = matchRoute({ to: "/files" });
  const reader = matchRoute({ to: "/files/$documentId" });
  const isPage = !!matchRoute({ to: "/settings" }) || !!matchRoute({ to: "/review" }) || !!matchRoute({ to: "/files", fuzzy: true });
  const note = isPage ? false : matchRoute({ to: "/$moduleId" });
  const scope = useRouterState({ select: state => (state.location.search as { module?: unknown }).module });
  return <>
    <div id={PDF_TOOLBAR_ID} className={reader ? "flex items-center gap-1" : "hidden"} />
    {files && !reader && isTauri() && <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => pickPdfs(typeof scope === "string" ? scope : undefined)}>
      <Plus />Add PDF
    </Button>}
    {note && <NotePdfToggle moduleId={note.moduleId} />}
  </>;
}
