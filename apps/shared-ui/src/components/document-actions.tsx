import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteDocument, renameDocument, type DocumentRecord } from "@/lib/documents";
import { documentName } from "@/lib/pdf-state";
import { documentsKey } from "@/lib/use-documents";
import { openPdfPane } from "@/lib/pdf-pane";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "./ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
export function DocumentActions({ doc, children }: { doc: DocumentRecord; children: ReactNode }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(documentName(doc.name));
  const mutation = useMutation({ mutationFn: () => action === "delete" ? deleteDocument({ id: doc.id }) : renameDocument({ id: doc.id, name: documentName(name.trim()) + ".pdf" }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: documentsKey }); setAction(null); } });
  return <>
    <ContextMenu><ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger><ContextMenuContent>
      <ContextMenuItem onClick={() => void navigate({ to: "/files/$documentId", params: { documentId: doc.id } })}>Open</ContextMenuItem>
      <ContextMenuItem onClick={() => { openPdfPane(doc.moduleId, doc.id); void navigate({ to: "/$moduleId", params: { moduleId: doc.moduleId } }); }}>Open beside note</ContextMenuItem>
      <ContextMenuItem onClick={() => { mutation.reset(); setName(documentName(doc.name)); setAction("rename"); }}>Rename</ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => { mutation.reset(); setAction("delete"); }}>Delete</ContextMenuItem>
    </ContextMenuContent></ContextMenu>
    <Dialog open={action !== null} onOpenChange={open => { if (!open && !mutation.isPending) setAction(null); }}><DialogContent>
      <form onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
        <DialogHeader><DialogTitle>{action === "delete" ? "Delete PDF?" : "Rename PDF"}</DialogTitle>
          {action === "delete" && <DialogDescription>“{documentName(doc.name)}” will be removed from every device. This cannot be undone.</DialogDescription>}
        </DialogHeader>
        {action === "rename" && <div className="grid gap-2 py-4"><Label htmlFor={`pdf-name-${doc.id}`}>Name</Label><Input id={`pdf-name-${doc.id}`} value={name} onChange={event => setName(event.target.value)} required disabled={mutation.isPending} /></div>}
        {mutation.error && <p role="alert" className="py-2 text-sm text-destructive">{mutation.error.message}</p>}
        <DialogFooter><DialogClose render={<Button variant="outline" disabled={mutation.isPending}>Cancel</Button>} /><Button type="submit" variant={action === "delete" ? "destructive" : "default"} disabled={mutation.isPending || (action === "rename" && !name.trim())}>{action === "delete" ? "Delete PDF" : "Rename"}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </>;
}
