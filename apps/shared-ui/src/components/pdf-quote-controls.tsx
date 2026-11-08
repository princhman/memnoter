import { useEditorState } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { useActiveEditor } from "@/lib/active-editor-context";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { isWriteAdmitted, retryFailedImages } from "@/lib/write-lifecycle";
import { outline } from "@/lib/outline";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export function PdfQuoteControls({ moduleId }: { moduleId: string }) {
  const pending = useSelector(pendingPdfQuote, state => state);
  const { activeEditor } = useActiveEditor();
  const [choosing, setChoosing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const active = activeEditor?.moduleId === moduleId && activeEditor.isReady && !activeEditor.editor.isDestroyed && activeEditor.editor.isEditable ? activeEditor : null;
  const headings = useEditorState({ editor: active?.editor ?? null, selector: ({ editor }) => editor ? outline(editor.state.doc) : [] }) ?? [];
  useEffect(() => {
    setChoosing(Boolean(pending?.moduleId === moduleId && pending.section && pending.status === "draft" && active));
  }, [pending?.file, active?.editor, moduleId]);
  if (!pending || pending.moduleId !== moduleId) return null;
  const insert = (target: { position: number } | { headingId: string | null }) => {
    if (!active || active.editor.isDestroyed || !active.editor.isEditable || pendingPdfQuote.state?.file !== pending.file || pendingPdfQuote.state.status !== "draft") return;
    if (!isWriteAdmitted()) {
      pendingPdfQuote.setState(() => ({ ...pending, error: "Saving is temporarily unavailable. Try again shortly." }));
      return;
    }
    const draft = pending;
    setChoosing(false);
    pendingPdfQuote.setState(() => ({ ...draft, status: "saving" }));
    void active.insertQuote(active.editor, draft.file, draft.source, target,
      () => { if (pendingPdfQuote.state?.file === draft.file) pendingPdfQuote.setState(() => null); },
      () => { if (pendingPdfQuote.state?.file === draft.file) pendingPdfQuote.setState(() => ({ ...draft, status: "draft", error: undefined })); },
    ).catch(error => {
      pendingPdfQuote.setState(current => current?.file === draft.file ? {
        ...current, status: current.status === "error" ? "error" : "draft",
        error: error instanceof Error ? error.message : "Could not save the quote. Try again.",
      } : current);
    });
  };
  return <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-xs" role="status">
    <span>{pending.status === "saving" ? "Saving quote…" : pending.status === "error" ? "Quote could not be saved" : "Image quote ready"}</span>
    {pending.error && <span role="alert">{pending.error}</span>}
    {pending.status === "error" && <>
      <Button size="xs" disabled={retrying} onClick={() => {
        setRetrying(true);
        void retryFailedImages().catch(() => {}).finally(() => setRetrying(false));
      }}>{retrying ? "Retrying…" : "Retry images"}</Button>
      <span>To choose another destination, discard failed images in the save alert. Your quote will stay ready.</span>
    </>}
    {pending.status === "draft" && <>
      {!pending.section && <Button size="xs" disabled={!active} onClick={() => { if (active) insert({ position: active.editor.state.selection.from }); }}>Quote at cursor</Button>}
      <Button size="xs" disabled={!active} onClick={() => setChoosing(true)}>Choose section…</Button>
      <Button size="xs" variant="ghost" onClick={() => { setChoosing(false); pendingPdfQuote.setState(() => null); }}>Discard</Button>
      {!active && <span>Waiting for this module’s editable note…</span>}
    </>}
    <Dialog open={choosing && pending.status === "draft"} onOpenChange={setChoosing}>
      <DialogContent><DialogTitle>Add quote to section</DialogTitle>
        <div className="grid max-h-80 gap-1 overflow-auto">
          {headings.map(heading => <Button key={heading.id ?? heading.pos} variant="ghost" className="h-auto justify-start whitespace-normal text-left" style={{ paddingLeft: `${12 + heading.ancestors.length * 12}px` }} disabled={!active || !heading.id} onClick={() => { if (heading.id) insert({ headingId: heading.id }); }}>{heading.title}</Button>)}
          <Button variant="ghost" className="justify-start" disabled={!active} onClick={() => insert({ headingId: null })}>End of note</Button>
        </div>
        <Button variant="outline" onClick={() => setChoosing(false)}>Cancel</Button>
      </DialogContent>
    </Dialog>
  </div>;
}
