import { useDocuments } from "@/lib/use-documents";
import { updatePdfPane, requestPdfPage } from "@/lib/pdf-pane";
import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { call, fileUrl } from "@/lib/backend";
import { bankTarget, partOutline, useBank, useBankEdit, type Bank } from "@/lib/question-bank";
import { Button } from "./ui/button";
import { ToolButton } from "./ui/tool-button";

function CropImage({ id, alt }: { id: string; alt: string }) {
  const { data, isError } = useQuery({ queryKey: ["bank-image", id], queryFn: () => call<string>("resolve_card_image", { fileId: id }).then(fileUrl), retry: false, staleTime: Infinity });
  return data ? <img className="max-h-64 max-w-full object-contain object-left" src={data} alt={alt} /> : <p className="rounded-lg bg-muted p-5 text-sm text-muted-foreground">{isError ? "Crop unavailable on this device" : "Loading crop…"}</p>;
}
export function QuestionBank({ moduleId }: { moduleId: string }) {
  const { data: bank, error, isLoading, refetch } = useBank(moduleId, true);
  const { data: documents = [] } = useDocuments(moduleId);
  const edit = useBankEdit(moduleId);
  const target = useSelector(bankTarget, s => s?.moduleId === moduleId ? s : null);
  const [busy, setBusy] = useState(false); const [failure, setFailure] = useState(""); const [label, setLabel] = useState("");
  const questions = Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  useEffect(() => { setFailure(""); }, [moduleId]);
  const run = async (args: Parameters<typeof edit>[0]) => {
    setBusy(true); setFailure("");
    try { await edit(args); setLabel(""); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); await refetch(); }
    finally { setBusy(false); }
  };
  return <section aria-label="Question bank" className="mx-auto w-full max-w-3xl pb-16">
    <div className="mb-7 flex items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">Question bank</h1><p className="mt-1 text-sm text-muted-foreground">Collect questions and their parts from your PDFs.</p></div><span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">Development preview · offline</span></div>
    {(failure || error) && <p role="alert" className="mb-4 text-sm text-destructive">{failure || error?.message}</p>}
    {isLoading && <p>Loading questions…</p>}
    {!isLoading && !questions.length && <div className="rounded-xl bg-muted/50 p-8"><h2 className="text-lg font-medium">Your first question starts with a crop</h2><p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">Open a PDF in the files panel, choose “Crop question”, then drag around a question. You can add more crops and nested parts as you go.</p></div>}
    <div className="space-y-10">{questions.map(([qid, question], index) => {
      const revision = bank!.revisions[question.revisionId]; const outline = partOutline(revision, index + 1);
      return <article key={qid} className="space-y-3" aria-label={`Question ${index + 1}`}><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Question {index + 1}{question.title && <span className="ml-2 font-normal text-muted-foreground">{question.title}</span>}</h2><ToolButton label={`Delete question ${index + 1}`} disabled={busy} onClick={() => void run({ kind: "deleteQuestion", questionId: qid, expectedRevisionId: question.revisionId })}><Trash2 /></ToolButton></div>
        {outline.map(part => <div key={part.id} style={{ marginLeft: part.depth * 18 }} className="rounded-xl bg-muted/30 p-3">
          <button className={`mb-3 flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm font-medium ${target?.questionId === qid && target.partId === part.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`} onClick={() => bankTarget.setState(() => ({ moduleId, questionId: qid, partId: part.id }))}><span>{part.depth ? part.label : `Question ${index + 1}`}</span><span className="text-xs font-normal text-muted-foreground">{target?.questionId === qid && target.partId === part.id ? "Crop target" : part.leaf ? "Leaf part" : "Shared context"}</span></button>
          <div className="space-y-4">{revision.parts[part.id].cropIds.map((cid, cropIndex, crops) => {
            const crop = revision.crops[cid];
            return <div key={cid}><CropImage id={crop.assetId} alt={`Question ${part.label}, crop ${cropIndex + 1}`} /><div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"><button className="mr-auto text-left hover:text-foreground" onClick={() => { updatePdfPane(moduleId, { open: true, active: crop.sourcePdfFileId }); requestPdfPage(crop.sourcePdfFileId, crop.pageIndex + 1); }}>{documents.find(d => d.id === crop.sourcePdfFileId)?.name ?? "Source PDF"} · page {crop.pageIndex + 1}{crop.rotation ? ` · ${crop.rotation}°` : ""}</button>
              <ToolButton label="Move crop earlier" disabled={busy || cropIndex === 0} onClick={() => void run({ kind: "reorderCrop", questionId: qid, partId: part.id, expectedRevisionId: question.revisionId, cropId: cid, index: cropIndex - 1 })}><ArrowUp /></ToolButton>
              <ToolButton label="Move crop later" disabled={busy || cropIndex === crops.length - 1} onClick={() => void run({ kind: "reorderCrop", questionId: qid, partId: part.id, expectedRevisionId: question.revisionId, cropId: cid, index: cropIndex + 1 })}><ArrowDown /></ToolButton>
              <select aria-label={`Move crop ${cropIndex + 1} to part`} className="max-w-32 rounded bg-transparent p-1 text-xs" disabled={busy} value={part.id} onChange={event => void run({ kind: "moveCrop", questionId: qid, partId: event.target.value, expectedRevisionId: question.revisionId, cropId: cid })}>{outline.map(p => <option key={p.id} value={p.id}>Part {p.label}</option>)}</select>
              <ToolButton label="Remove crop" disabled={busy} onClick={() => void run({ kind: "removeCrop", questionId: qid, partId: part.id, expectedRevisionId: question.revisionId, cropId: cid })}><Trash2 /></ToolButton>
            </div></div>;
          })}</div>
          {!revision.parts[part.id].cropIds.length && <p className="py-3 text-sm text-muted-foreground">No crops yet. Select this part to add one from a PDF.</p>}
        </div>)}
      </article>;
    })}</div>
    {target && bank && bank.questions[target.questionId] && !bank.questions[target.questionId].deleted && <form aria-label={`Add a part under ${targetOptions(bank).find(p => p.partId === target.partId && p.questionId === target.questionId)?.label ?? "selected target"}`} className="mt-6 flex items-center gap-2" onSubmit={event => { event.preventDefault(); void run({ kind: "newPart", questionId: target.questionId, partId: target.partId, expectedRevisionId: bank.questions[target.questionId].revisionId, label }); }}><input aria-label="New part label" placeholder="New part label, e.g. (b)" className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 text-sm" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} /><Button type="submit" size="sm" variant="secondary" disabled={busy || !label.trim()}><Plus />Add part</Button></form>}
  </section>;
}

export function targetOptions(bank: Bank | null | undefined) {
  return Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order).flatMap(([qid, q], index) => partOutline(bank!.revisions[q.revisionId], index + 1).map(p => ({ questionId: qid, partId: p.id, label: `Question ${p.label}` })));
}
