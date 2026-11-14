import { useDocuments } from "@/lib/use-documents";
import { updatePdfPane, requestPdfPage } from "@/lib/pdf-pane";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ArrowDown, ArrowUp, FileText, Trash2 } from "lucide-react";
import { call, fileUrl } from "@/lib/backend";
import { questionLabel, setBankTarget, useBankTarget, partOutline, useBank, useBankEdit, type BankEdit } from "@/lib/question-bank";
import { cn } from "@/lib/utils";
import { ToolButton } from "./ui/tool-button";

function CropImage({ id, alt }: { id: string; alt: string }) {
  const { data, isError } = useQuery({ queryKey: ["bank-image", id], queryFn: () => call<string>("resolve_card_image", { fileId: id }).then(fileUrl), retry: false, staleTime: Infinity });
  return data ? <img className="block max-w-full rounded-sm bg-white" src={data} alt={alt} /> : <p className="rounded-md bg-muted p-5 text-sm text-muted-foreground">{isError ? "Crop unavailable on this device" : "Loading…"}</p>;
}

const own = (label: string) => `(${label.replace(/^\((.*)\)$/, "$1")})`;

// A label that becomes a text field on double-click (or Enter/F2 when focused).
// Enter or leaving the field saves, Escape cancels.
function EditableLabel({ editing, value, placeholder, onStart, onSave, onCancel, children, ...rest }: { editing: boolean; value: string; placeholder?: string; onStart: () => void; onSave: (value: string) => void; onCancel: () => void; children: React.ReactNode } & Omit<React.ComponentProps<"button">, "onDoubleClick">) {
  const settled = useRef(false);
  if (!editing) return <button type="button" title="Double-click to rename" {...rest} onDoubleClick={onStart} onKeyDown={event => { if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); onStart(); } }}>{children}</button>;
  const finish = (save: boolean, text: string) => { if (settled.current) return; settled.current = true; if (save) onSave(text); else onCancel(); };
  return <input autoFocus defaultValue={value} placeholder={placeholder} aria-label="Name" maxLength={120} className="h-7 w-40 rounded-md border bg-background px-2 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring" onFocus={event => { settled.current = false; event.currentTarget.select(); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") finish(true, event.currentTarget.value); else if (event.key === "Escape") finish(false, ""); }} onBlur={event => finish(true, event.currentTarget.value)} />;
}

// The bank reads like the worksheet it came from: each question's number, its
// shared crops, then its parts in the margin. Clicking a question or part
// makes it where the next crop goes; crop controls appear on hover.
export function QuestionBank({ moduleId }: { moduleId: string }) {
  const { data: bank, error, isLoading, refetch } = useBank(moduleId, true);
  const { data: documents = [] } = useDocuments(moduleId);
  const edit = useBankEdit(moduleId);
  const target = useBankTarget(moduleId, bank);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [failure, setFailure] = useState("");
  const [folds, setFolds] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem("bank-folds") || "{}"); } catch { return {}; } });
  const toggle = (key: string) => setFolds(previous => { const next = { ...previous, [key]: !previous[key] }; try { localStorage.setItem("bank-folds", JSON.stringify(next)); } catch {} return next; });
  const questions = Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  useEffect(() => { setFailure(""); }, [moduleId]);
  const run = async (args: BankEdit) => {
    setBusy(true); setFailure("");
    try { await edit(args); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); await refetch(); }
    finally { setBusy(false); }
  };
  return <section aria-label="Question bank" className="mx-auto w-full max-w-3xl pb-16">
    <h1 className="mb-8 text-2xl font-semibold tracking-tight">Question bank</h1>
    {(failure || error) && <p role="alert" className="mb-4 text-sm text-destructive">{failure || error?.message}</p>}
    {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
    {!isLoading && !questions.length && <p className="text-sm text-muted-foreground">Open a PDF and choose <span className="text-foreground">Crop question</span> to add questions.</p>}
    <div className="space-y-12">{questions.map(([qid, question], index) => {
      const revision = bank!.revisions[question.revisionId]; const outline = partOutline(revision, questionLabel(question.title, index + 1));
      return <article key={qid} aria-label={`Question ${index + 1}`} className="group/question">
        {outline.map((part, position) => {
          const ancestors: typeof outline = [];
          for (const preceding of outline.slice(0, position)) { ancestors[preceding.depth] = preceding; ancestors.length = preceding.depth + 1; }
          if (ancestors.slice(0, part.depth).some(parent => folds[`${moduleId}:${qid}:${parent.id}`])) return null;
          const key = `${moduleId}:${qid}:${part.id}`; const folded = !!folds[key];
          const descendants = outline.slice(position + 1); const end = descendants.findIndex(child => child.depth <= part.depth);
          const subtree = descendants.slice(0, end < 0 ? undefined : end); const parts = subtree.filter(child => child.depth === part.depth + 1).length;
          const root = part.depth === 0; const current = target?.questionId === qid && target.partId === part.id;
          const parentId = revision.parts[part.id].parentId;
          const siblings = root ? [] : Object.entries(revision.parts).filter(([, p]) => p.parentId === parentId).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
          const place = siblings.findIndex(([id]) => id === part.id);
          const cropIds = revision.parts[part.id].cropIds; const foldable = cropIds.length > 0 || subtree.length > 0;
          return <div key={part.id} style={{ marginLeft: Math.max(0, part.depth - 1) * 24 }} className={cn("group/part border-l-2 py-1.5 pl-3", current ? "border-primary" : "border-transparent", !root && "mt-3")}>
            <div className="flex items-start gap-1">
              <span className="flex h-7 w-4 shrink-0 items-center justify-center">{foldable && <button type="button" aria-label={`${folded ? "Expand" : "Fold"} ${part.label}`} aria-expanded={!folded} className="text-muted-foreground/70 hover:text-foreground" onClick={() => toggle(key)}><ChevronRight size={14} className={folded ? "" : "rotate-90"} /></button>}</span>
              <EditableLabel editing={renaming === key} value={root ? question.title : own(revision.parts[part.id].label)} placeholder={root ? String(index + 1) : undefined} onStart={() => setRenaming(key)} onCancel={() => setRenaming(null)}
                onSave={text => { setRenaming(null); const trimmed = text.trim(); const pin = { questionId: qid, expectedRevisionId: question.revisionId };
                  if (root) { if (trimmed !== question.title.trim()) void run({ kind: "renameQuestion", ...pin, title: trimmed }); }
                  else if (trimmed && trimmed !== own(revision.parts[part.id].label)) void run({ kind: "renamePart", ...pin, partId: part.id, label: trimmed }); }}
                aria-label={`Add next crops to ${part.label}`} aria-pressed={current} className={cn("text-left font-semibold tabular-nums", root ? "text-xl leading-7" : "text-base leading-7 text-muted-foreground", current && "text-foreground")} onClick={() => setBankTarget({ moduleId, questionId: qid, partId: part.id })}>{root ? questionLabel(question.title, index + 1) : own(revision.parts[part.id].label)}</EditableLabel>
              {folded && parts > 0 && <span className="self-center text-sm text-muted-foreground">{parts} {parts === 1 ? "part" : "parts"}</span>}
              {root && <div className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover/question:opacity-100 focus-within:opacity-100">
                <ToolButton size="icon-xs" label={`Move question ${index + 1} up`} disabled={busy || index === 0} onClick={() => void run({ kind: "moveQuestion", questionId: qid, expectedRevisionId: question.revisionId, index: index - 1 })}><ArrowUp /></ToolButton>
                <ToolButton size="icon-xs" label={`Move question ${index + 1} down`} disabled={busy || index === questions.length - 1} onClick={() => void run({ kind: "moveQuestion", questionId: qid, expectedRevisionId: question.revisionId, index: index + 1 })}><ArrowDown /></ToolButton>
                <ToolButton size="icon-xs" label={`Delete question ${index + 1}`} disabled={busy} onClick={() => void run({ kind: "deleteQuestion", questionId: qid, expectedRevisionId: question.revisionId })}><Trash2 /></ToolButton></div>}
              {!root && siblings.length > 1 && <div className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover/part:opacity-100 focus-within:opacity-100">
                <ToolButton size="icon-xs" label={`Move part ${part.label} up`} disabled={busy || place === 0} onClick={() => void run({ kind: "movePart", questionId: qid, partId: part.id, expectedRevisionId: question.revisionId, index: place - 1 })}><ArrowUp /></ToolButton>
                <ToolButton size="icon-xs" label={`Move part ${part.label} down`} disabled={busy || place === siblings.length - 1} onClick={() => void run({ kind: "movePart", questionId: qid, partId: part.id, expectedRevisionId: question.revisionId, index: place + 1 })}><ArrowDown /></ToolButton>
              </div>}
            </div>
            <div className="mt-2 min-w-0 space-y-3 pl-5 empty:hidden">
              {!folded && cropIds.map((cid, cropIndex) => {
                const crop = revision.crops[cid];
                const pin = { questionId: qid, partId: part.id, expectedRevisionId: question.revisionId, cropId: cid };
                return <figure key={cid} className="group/crop relative">
                  <CropImage id={crop.assetId} alt={`Question ${part.label}, crop ${cropIndex + 1}`} />
                  <div className="absolute top-1 right-1 flex gap-0.5 rounded-md floating-surface bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-hover/crop:opacity-100 focus-within:opacity-100">
                    <ToolButton size="icon-xs" label={`Open ${documents.find(d => d.id === crop.sourcePdfFileId)?.name ?? "source PDF"}, page ${crop.pageIndex + 1}`} onClick={() => { updatePdfPane(moduleId, { open: true, active: crop.sourcePdfFileId }); requestPdfPage(crop.sourcePdfFileId, crop.pageIndex + 1); }}><FileText /></ToolButton>
                    {cropIds.length > 1 && <>
                      <ToolButton size="icon-xs" label="Move up" disabled={busy || cropIndex === 0} onClick={() => void run({ kind: "reorderCrop", ...pin, index: cropIndex - 1 })}><ArrowUp /></ToolButton>
                      <ToolButton size="icon-xs" label="Move down" disabled={busy || cropIndex === cropIds.length - 1} onClick={() => void run({ kind: "reorderCrop", ...pin, index: cropIndex + 1 })}><ArrowDown /></ToolButton>
                    </>}
                    <ToolButton size="icon-xs" label="Remove crop" disabled={busy} onClick={() => void run({ kind: "removeCrop", ...pin })}><Trash2 /></ToolButton>
                  </div>
                </figure>;
              })}
              {!folded && !cropIds.length && !root && <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">No crops yet<ToolButton size="icon-xs" label={`Remove part ${part.label}`} disabled={busy} onClick={() => void run({ kind: "removePart", questionId: qid, partId: part.id, expectedRevisionId: question.revisionId })}><Trash2 /></ToolButton></div>}
            </div>
          </div>;
        })}
      </article>;
    })}</div>
  </section>;
}

