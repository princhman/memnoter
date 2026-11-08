import { action, formatKeys, matchesShortcut } from "@/lib/shortcuts";
import { useEditorState } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { useActiveEditor } from "@/lib/active-editor-context";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { isWriteAdmitted, retryFailedImages } from "@/lib/write-lifecycle";
import { outline } from "@/lib/outline";
import { ChevronDown, X } from "lucide-react";
import { ToolButton } from "./ui/tool-button";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export function PdfQuoteControls({ moduleId }: { moduleId: string }) {
  const pending = useSelector(pendingPdfQuote, state => state);
  const { activeEditor } = useActiveEditor();
  const [choosing, setChoosing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const primaryAction = useRef<(() => void) | null>(null);
  primaryAction.current = null;
  useEffect(() => {
    const insert = (event: KeyboardEvent) => {
      if (!primaryAction.current || event.repeat || event.isComposing || !matchesShortcut(event, action("pdf.quote.insert").keys)) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      event.preventDefault(); event.stopPropagation(); primaryAction.current();
    };
    window.addEventListener("keydown", insert, true);
    return () => window.removeEventListener("keydown", insert, true);
  }, []);
  const pickerTrigger = useRef<HTMLElement | null>(null);
  const active = activeEditor?.moduleId === moduleId && activeEditor.isReady && !activeEditor.editor.isDestroyed && activeEditor.editor.isEditable ? activeEditor : null;
  const headings = useEditorState({ editor: active?.editor ?? null, selector: ({ editor }) => editor ? outline(editor.state.doc) : [] }) ?? [];
  useEffect(() => {
    setChoosing(false);
  }, [pending?.file, moduleId]);
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
  const openSectionPicker = () => {
    if (!active || pending.status !== "draft") return;
    pickerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setChoosing(true);
  };
  const handleInsertQuote = () => {
    if (!active || pending.status !== "draft") return;
    if (pending.section) openSectionPicker();
    else insert({ position: active.editor.state.selection.from });
  };
  if (active && pending.status === "draft" && !choosing) primaryAction.current = handleInsertQuote;
  const sourceName = pending.source.name.split(/[\\/]/).pop() || "PDF";
  const waiting = pending.status === "draft" && !active;
  return <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex max-h-[calc(100%-1.5rem)] justify-end">
    <div className="pointer-events-auto min-w-0 max-w-sm overflow-y-auto rounded-lg floating-surface p-1 text-xs shadow-md" role="status">
      <div role="group" aria-label="Image quote actions" className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate px-1 text-muted-foreground" title={waiting ? "Waiting for this module’s editable note" : `${sourceName}, page ${pending.source.page}`}>
          {waiting ? "Waiting for note…" : `${sourceName}, page ${pending.source.page}`}
        </span>
        <Button size="sm" title={`Insert quote (${formatKeys(action("pdf.quote.insert").keys)})`} aria-keyshortcuts="Meta+Enter Control+Enter" disabled={!active || pending.status !== "draft"} onClick={handleInsertQuote}>
          {pending.status === "saving" ? "Saving quote…" : "Insert quote"}
        </Button>
        <ToolButton size="icon-sm" label="Choose section" disabled={!active || pending.status !== "draft"} onClick={openSectionPicker}>
          <ChevronDown />
        </ToolButton>
        <ToolButton size="icon-sm" label="Dismiss quote" disabled={pending.status !== "draft"} onClick={() => {
          setChoosing(false);
          pendingPdfQuote.setState(() => null);
        }}><X /></ToolButton>
      </div>
      {(pending.error || pending.status === "error") && <div className="grid gap-2 p-2 [overflow-wrap:anywhere]">
        <span role="alert">{pending.error || "Quote could not be saved"}</span>
        {pending.status === "error" && <>
          <Button size="xs" variant="outline" className="justify-self-start" disabled={retrying} onClick={() => {
            setRetrying(true);
            void retryFailedImages().catch(() => {}).finally(() => setRetrying(false));
          }}>{retrying ? "Retrying" : "Retry images"}</Button>
          <span>To choose another destination, discard failed images in the save alert. Your quote will stay ready.</span>
        </>}
      </div>}
      <Dialog open={choosing && pending.status === "draft"} onOpenChange={setChoosing}>
        <DialogContent finalFocus={pickerTrigger}><DialogTitle>Add quote to section</DialogTitle>
          <div className="grid max-h-80 gap-1 overflow-auto">
            {headings.map(heading => <Button key={heading.id ?? heading.pos} variant="ghost" className="h-auto justify-start whitespace-normal text-left" style={{ paddingLeft: `${12 + heading.ancestors.length * 12}px` }} disabled={!active || !heading.id} onClick={() => { if (heading.id) insert({ headingId: heading.id }); }}>{heading.title}</Button>)}
            <Button variant="ghost" className="justify-start" disabled={!active} onClick={() => insert({ headingId: null })}>End of note</Button>
          </div>
          <Button variant="outline" onClick={() => setChoosing(false)}>Cancel</Button>
        </DialogContent>
      </Dialog>
    </div>
  </div>;
}
