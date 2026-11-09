import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCommand } from "@/lib/commands";
import { call, isNativeHost, isTauri, postNativeEvent } from "@/lib/backend";
import { addDocumentBytes } from "@/lib/documents";
import { useDocuments, documentsKey } from "@/lib/use-documents";
import { useModules } from "@/lib/modules";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Toast } from "./ui/toast";

export const DROP_PDFS_EVENT = "memnoter:drop-pdfs";
export function dropPdfs(files: File[], moduleId?: string) {
  window.dispatchEvent(new CustomEvent(DROP_PDFS_EVENT, { detail: { files, moduleId } }));
}
const PICK_PDFS_EVENT = "memnoter:pick-pdfs";
// Opens the file picker for a module, or asks which module first.
export function pickPdfs(moduleId?: string) {
  if (isNativeHost() && moduleId) { postNativeEvent("pickPdfs", { moduleId }); return; }
  window.dispatchEvent(new CustomEvent(PICK_PDFS_EVENT, { detail: { moduleId } }));
}
export function AddPdf() {
  const location = useRouterState({ select: state => state.location });
  const matches = useRouterState({ select: state => state.matches });
  const { data: modules = [] } = useModules();
  const client = useQueryClient();
  const { data: documents = [] } = useDocuments();
  const [pending, setPending] = useState<{ files: File[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const match = matches.find(match => "moduleId" in match.params);
  const reader = matches.find(match => "documentId" in match.params);
  const readerId = reader && "documentId" in reader.params ? reader.params.documentId : undefined;
  const readerModule = documents.find(doc => doc.id === readerId)?.moduleId;
  const moduleId = "module" in location.search && typeof location.search.module === "string" ? location.search.module
    : match && "moduleId" in match.params ? String(match.params.moduleId) : readerModule;
  async function add(target: string, files: File[]) {
    setBusy(true);
    try {
      if (files.length) {
        for (const file of files) {
          try { await addDocumentBytes({ moduleId: target, name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) }); }
          catch (error) { setError(String(error instanceof Error ? error.message : error)); }
        }
      } else {
        const results = await call<({ Ok: unknown } | { Err: string })[]>("pick_pdfs", { moduleId: target });
        const failures = results.flatMap(result => "Err" in result ? [result.Err] : []);
        if (failures.length) setError(failures.join("\n"));
      }
    } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); setPending(null); void client.invalidateQueries({ queryKey: documentsKey }); }
  }
  function pick(target = moduleId) {
    if (!isTauri()) return;
    if (target) return void add(target, []);
    setPending({ files: [] });
  }
  useCommand({ id: "pdf.add", title: "Add PDF…", run: () => pick() });
  // Listeners outlive renders, so they call through the latest picker.
  const latestPick = useRef(pick);
  latestPick.current = pick;
  useEffect(() => {
    const receive = (event: Event) => latestPick.current((event as CustomEvent<{ moduleId?: string }>).detail.moduleId);
    window.addEventListener(PICK_PDFS_EVENT, receive);
    return () => window.removeEventListener(PICK_PDFS_EVENT, receive);
  }, []);
  // The drop event carries File objects without serializing their bytes.
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ files: File[]; moduleId?: string }>).detail;
      if (detail.moduleId) void add(detail.moduleId, detail.files);
      else setPending({ files: detail.files });
    };
    window.addEventListener(DROP_PDFS_EVENT, receive);
    return () => window.removeEventListener(DROP_PDFS_EVENT, receive);
  }, [client]);
  return <>
    <Dialog open={pending !== null} onOpenChange={open => { if (!open && !busy) setPending(null); }}>
      <DialogContent><DialogHeader><DialogTitle>Add PDFs to a module</DialogTitle></DialogHeader>
        <div className="grid gap-1">{modules.map(module => <Button key={module.id} variant="ghost" disabled={busy} onClick={() => void add(module.id, pending?.files ?? [])}>{module.name}</Button>)}</div>
        {!modules.length && <p className="text-sm text-muted-foreground">Create a module first.</p>}
      </DialogContent>
    </Dialog>
    {error && <Toast role="alert" className="flex items-center gap-3 p-3 text-sm"><span className="whitespace-pre-line">{error}</span><Button variant="ghost" onClick={() => setError("")}>Dismiss</Button></Toast>}
  </>;
}
