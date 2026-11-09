import { registerCommand } from "@/lib/commands";
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
import { IconTooltip } from "./ui/icon-tooltip";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export function PdfQuoteControls({ moduleId, onInserted }: { moduleId: string; onInserted?: () => void }) {
  const pending = useSelector(pendingPdfQuote, state => state);
  const { activeEditor } = useActiveEditor();
  const [choosing, setChoosing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const insertCommand = useRef<(() => void) | null>(null);
  insertCommand.current = null;
  const primaryAction = useRef<((event: KeyboardEvent) => void) | null>(null);
  primaryAction.current = null;
  useEffect(() => {
    const insert = (event: KeyboardEvent) => {
      if (!primaryAction.current || event.defaultPrevented || event.repeat || event.isComposing || !matchesShortcut(event, action("pdf.quote.insert").keys)) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      primaryAction.current(event);
    };
    window.addEventListener("keydown", insert, true);
    return () => window.removeEventListener("keydown", insert, true);
  }, []);
  const pickerTrigger = useRef<HTMLElement | null>(null);
  const active = activeEditor?.moduleId === moduleId && activeEditor.isReady && !activeEditor.editor.isDestroyed && activeEditor.editor.isEditable ? activeEditor : null;
  const headings = useEditorState({ editor: active?.editor ?? null, selector: ({ editor }) => editor ? outline(editor.state.doc) : [] }) ?? [];
  useEffect(() => {
    setChoosing(false);
  }, [pending?.id, moduleId]);
  useEffect(() => {
    if (pending?.moduleId !== moduleId || pending.status !== "draft" || !active || choosing) return;
    return registerCommand({ ...action("pdf.quote.insert"), keywords: ["pdf", "quote", "cursor"], run: () => insertCommand.current?.() });
  }, [pending?.moduleId, pending?.status, moduleId, active?.editor, choosing]);
  if (!pending || pending.moduleId !== moduleId) return null;
  const insert = (target: { position: number } | { headingId: string | null }) => {
    if (!active || active.editor.isDestroyed || !active.editor.isEditable || pendingPdfQuote.state?.id !== pending.id || pendingPdfQuote.state.status !== "draft") return;
    if (!isWriteAdmitted()) {
      pendingPdfQuote.setState(() => ({ ...pending, error: "Saving is temporarily unavailable. Try again shortly." }));
      return;
    }
    const draft = pending;
    setChoosing(false);
    pendingPdfQuote.setState(() => ({ ...draft, status: "saving" }));
    if (draft.kind === "text") {
      try {
        active.insertTextQuote(active.editor, draft.parts, target);
        if (pendingPdfQuote.state?.id === draft.id) { pendingPdfQuote.setState(() => null); onInserted?.(); }
      } catch (error) {
        pendingPdfQuote.setState(current => current?.id === draft.id ? {
          ...current, status: "draft", error: error instanceof Error ? error.message : "Could not insert the quote. Try again.",
        } : current);
      }
      return;
    }
    void active.insertQuote(active.editor, draft, target,
      () => { if (pendingPdfQuote.state?.id === draft.id) { pendingPdfQuote.setState(() => null); onInserted?.(); } },
      () => { if (pendingPdfQuote.state?.id === draft.id) pendingPdfQuote.setState(() => ({ ...draft, status: "draft", error: undefined })); },
    ).catch(error => {
      pendingPdfQuote.setState(current => current?.id === draft.id ? {
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
    insert({ position: active.editor.state.selection.from });
  };
  if (active && pending.status === "draft" && !choosing) insertCommand.current = handleInsertQuote;
  if (active && pending.status === "draft" && !choosing) primaryAction.current = event => {
    if (event.target instanceof Element) {
      const editable = event.target.closest('input, textarea, select, [contenteditable="true"]');
      if (editable && !active.editor.view.dom.contains(editable)) return;
    }
    event.preventDefault();
    event.stopPropagation();
    handleInsertQuote();
  };
  const source = pending.kind === "image" ? pending.source : pending.parts[0]?.source;
  const sourceName = (source?.name ?? "PDF").split(/[\\/]/).pop() || "PDF";
  const waiting = pending.status === "draft" && !active;
  return <div data-pdf-quote-controls className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex max-h-[calc(100%-1.5rem)] justify-end">
    <div className="pdf-quote-bar pointer-events-auto min-w-0 max-w-md overflow-y-auto rounded-2xl floating-surface p-1 pl-3 text-xs shadow-md" role="status">
      <div role="group" aria-label={pending.kind === "image" ? "Image quote actions" : "Text quote actions"} className="flex min-w-0 items-center gap-2" onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}>
        <span className="pdf-quote-source flex min-w-0 flex-col leading-tight" title={waiting ? "Waiting for this module’s editable note" : `${sourceName}, page ${source?.page ?? ""}`}>
          {waiting ? <span className="truncate text-muted-foreground">Waiting for note…</span> : <>
            <span className="truncate font-medium text-foreground">{sourceName.replace(/\.pdf$/i, "")}</span>
            <span className="truncate text-muted-foreground">Page {source?.page ?? ""}</span>
          </>}
        </span>
        {/* One split button: insert here, or pick a section from the chevron. */}
        <div className="pdf-quote-split flex shrink-0 items-stretch">
          <IconTooltip label="Insert at cursor" hint={formatKeys(action("pdf.quote.insert").keys)}>
            <Button size="sm" className="rounded-r-none pr-2.5" aria-keyshortcuts="Meta+Enter Control+Enter" disabled={!active || pending.status !== "draft"} onClick={handleInsertQuote}>
              {pending.status === "saving" ? "Saving quote…" : "Insert at cursor"}
            </Button>
          </IconTooltip>
          <IconTooltip label="Choose section">
            <Button size="sm" className="rounded-l-none border-l border-l-primary-foreground/25 px-1.5" aria-label="Choose section" disabled={!active || pending.status !== "draft"} onClick={openSectionPicker}>
              <ChevronDown />
            </Button>
          </IconTooltip>
        </div>
        <ToolButton size="icon-xs" className="pdf-menu-close shrink-0" label="Dismiss quote" disabled={pending.status !== "draft"} onClick={() => {
          setChoosing(false);
          pendingPdfQuote.setState(() => null);
        }}><X /></ToolButton>
      </div>
      {(pending.error || pending.status === "error") && <div className="grid gap-2 p-2 [overflow-wrap:anywhere]">
        <span role="alert">{pending.error || "Quote could not be saved"}</span>
        {pending.kind === "image" && pending.status === "error" && <>
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
