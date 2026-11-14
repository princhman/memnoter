import { useDocuments } from "@/lib/use-documents";
import { updatePdfPane, requestPdfPage } from "@/lib/pdf-pane";
import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ArrowDown, ArrowUp, FileText, Trash2 } from "lucide-react";
import { call, fileUrl } from "@/lib/backend";
import { questionLabel, bankTarget, partOutline, useBank, useBankEdit, type BankEdit } from "@/lib/question-bank";
import { cn } from "@/lib/utils";
import { ToolButton } from "./ui/tool-button";

function CropImage({ id, alt }: { id: string; alt: string }) {
  const { data, isError } = useQuery({ queryKey: ["bank-image", id], queryFn: () => call<string>("resolve_card_image", { fileId: id }).then(fileUrl), retry: false, staleTime: Infinity });
  return data ? <img className="block max-w-full rounded-sm bg-white" src={data} alt={alt} /> : <p className="rounded-md bg-muted p-5 text-sm text-muted-foreground">{isError ? "Crop unavailable on this device" : "Loading…"}</p>;
}

const own = (label: string) => `(${label.replace(/^\((.*)\)$/, "$1")})`;

// The bank reads like the worksheet it came from: each question's number, its
// shared crops, then its parts in the margin. Clicking a question or part
// makes it where the next crop goes; crop controls appear on hover.
export function QuestionBank({ moduleId }: { moduleId: string }) {
  const { data: bank, error, isLoading, refetch } = useBank(moduleId, true);
  const { data: documents = [] } = useDocuments(moduleId);
  const edit = useBankEdit(moduleId);
  const target = useSelector(bankTarget, s => s?.moduleId === moduleId ? s : null);
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
          const count = [part, ...descendants.slice(0, end < 0 ? undefined : end)].reduce((sum, child) => sum + revision.parts[child.id].cropIds.length, 0);
          const root = part.depth === 0; const current = target?.questionId === qid && target.partId === part.id;
          const cropIds = revision.parts[part.id].cropIds;
          return <div key={part.id} style={{ marginLeft: Math.max(0, part.depth - 1) * 24 }} className={cn("flex gap-3 border-l-2 py-1.5 pl-3", current ? "border-primary" : "border-transparent", !root && "mt-3")}>
            <button type="button" aria-label={`${folded ? "Expand" : "Fold"} ${part.label}`} aria-expanded={!folded} className="self-start mt-1 text-muted-foreground" onClick={() => toggle(key)}><ChevronRight size={14} className={folded ? "" : "rotate-90"} /></button>
            <button type="button" aria-label={`Add next crops to ${part.label}`} aria-pressed={current} className={cn("w-10 shrink-0 text-left font-semibold tabular-nums", root ? "text-xl" : "text-base text-muted-foreground", current && "text-foreground")} onClick={() => bankTarget.setState(() => ({ moduleId, questionId: qid, partId: part.id }))}>{root ? questionLabel(question.title, index + 1) : own(revision.parts[part.id].label)}</button>
            <div className="min-w-0 flex-1 space-y-3">
              {folded && <span className="text-sm text-muted-foreground">{count} crops</span>}
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
            {root && <ToolButton size="icon-xs" className="opacity-0 transition-opacity group-hover/question:opacity-100 focus-visible:opacity-100" label={`Delete question ${index + 1}`} disabled={busy} onClick={() => void run({ kind: "deleteQuestion", questionId: qid, expectedRevisionId: question.revisionId })}><Trash2 /></ToolButton>}
          </div>;
        })}
      </article>;
    })}</div>
  </section>;
}

