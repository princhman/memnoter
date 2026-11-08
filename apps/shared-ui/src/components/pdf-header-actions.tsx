import { useMatchRoute, useRouterState } from "@tanstack/react-router";
import { ChevronDown, FileText, PanelRightClose, Plus } from "lucide-react";
import { useDocuments } from "@/lib/use-documents";
import { openPdfPane, updatePdfPane, usePdfPane } from "@/lib/pdf-pane";
import { documentName } from "@/lib/pdf-state";
import { isTauri } from "@/lib/backend";
import { pickPdfs } from "./add-pdf";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// The reader portals its page and zoom controls here, at the right end of the
// header, so they never run into the breadcrumbs.
export const PDF_TOOLBAR_ID = "pdf-toolbar";

// Picks which of the note's PDFs opens beside it.
function NotePdfMenu({ moduleId }: { moduleId: string }) {
  const { data: docs = [] } = useDocuments(moduleId);
  const pane = usePdfPane(moduleId);
  const canAdd = isTauri();
  if (!docs.length && !canAdd) return null;
  const shown = pane.open ? docs.find(doc => doc.id === pane.active) ?? docs[0] : undefined;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button size="xs" variant="ghost" className="text-muted-foreground" aria-label="Open a PDF beside the note">
      <FileText />PDFs<ChevronDown className="opacity-60" />
    </Button>} />
    <DropdownMenuContent align="end" className="min-w-48 max-w-80">
      {docs.length > 0 && <DropdownMenuRadioGroup value={shown?.id ?? ""} onValueChange={id => openPdfPane(moduleId, String(id))}>
        {docs.map(doc => <DropdownMenuRadioItem key={doc.id} value={doc.id} closeOnClick>
          <span className="truncate">{documentName(doc.name)}</span>
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>}
      {docs.length > 0 && <DropdownMenuSeparator />}
      {pane.open && shown && <DropdownMenuItem onClick={() => updatePdfPane(moduleId, { open: false })}><PanelRightClose />Hide PDF</DropdownMenuItem>}
      {canAdd && <DropdownMenuItem onClick={() => pickPdfs(moduleId)}><Plus />Add PDF…</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
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
    {note && <NotePdfMenu moduleId={note.moduleId} />}
  </>;
}
