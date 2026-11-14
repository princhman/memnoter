import { useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { bankTarget, useBank, useBankEdit, type CropDraft, type BankEdit } from "@/lib/question-bank";
import { targetOptions } from "./question-bank";
import { Button } from "./ui/button";

export function QuestionCropDialog({ moduleId, draft, onClose, onSaved }: { moduleId: string; draft: CropDraft; onClose: () => void; onSaved?: () => void }) {
  const query = useBank(moduleId, true); const edit = useBankEdit(moduleId);
  const selected = useSelector(bankTarget, s => s?.moduleId === moduleId ? s : null);
  const [kind, setKind] = useState<"newQuestion" | "addCrop" | "newPart">(selected ? "addCrop" : "newQuestion");
  const [target, setTarget] = useState(selected ? `${selected.questionId}/${selected.partId}` : "");
  const [label, setLabel] = useState(""); const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const options = targetOptions(query.data); const choice = options.find(p => `${p.questionId}/${p.partId}` === target);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const bytes = [...new Uint8Array(await draft.blob.arrayBuffer())];
      const crop = { sourcePdfFileId: draft.sourcePdfFileId, pageIndex: draft.pageIndex, rect: draft.rect, rotation: draft.rotation, pixelSize: draft.pixelSize, bytes };
      const args: BankEdit = { kind, title, label, crop };
      if (kind !== "newQuestion") {
        if (!choice || !query.data) throw new Error("Choose a question or part first");
        Object.assign(args, { questionId: choice.questionId, partId: choice.partId, expectedRevisionId: query.data.questions[choice.questionId].revisionId });
      }
      await edit(args); onClose(); onSaved?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); await query.refetch(); }
    finally { setBusy(false); }
  };
  return <section role="dialog" aria-label="Add PDF crop to question bank" className="absolute inset-x-3 bottom-3 z-40 mx-auto max-w-md rounded-xl bg-background p-4 text-foreground shadow-xl">
    <h2 className="text-base font-semibold">Add to question bank</h2>
    <img src={draft.url} alt="Selected question crop" className="my-3 max-h-36 w-full rounded-md bg-white object-contain" />
    <p className="mb-3 text-xs text-muted-foreground">Page {draft.pageIndex + 1} · saved as an offline crop</p>
    <div className="grid gap-2 text-sm"><label className="flex items-center gap-2"><input className="accent-primary" type="radio" name="crop-action" checked={kind === "newQuestion"} onChange={() => setKind("newQuestion")} />New question</label>
      <label className="flex items-center gap-2"><input className="accent-primary" type="radio" name="crop-action" checked={kind === "addCrop"} disabled={!options.length} onChange={() => setKind("addCrop")} />Add crop to current question / part</label>
      <label className="flex items-center gap-2"><input className="accent-primary" type="radio" name="crop-action" checked={kind === "newPart"} disabled={!options.length} onChange={() => setKind("newPart")} />New part…</label>
      {kind === "newQuestion" ? <input aria-label="Question title" className="mt-1 rounded-md bg-muted px-3 py-2" placeholder="Question title (optional)" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} /> : <label className="mt-1 grid gap-1 text-xs text-muted-foreground">{kind === "newPart" ? "Add a child under" : "Crop target"}<select className="rounded-md bg-muted px-3 py-2 text-sm text-foreground" aria-label="Crop target" value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose a question or part</option>{options.map(p => <option key={`${p.questionId}/${p.partId}`} value={`${p.questionId}/${p.partId}`}>{p.label}</option>)}</select></label>}
      {kind === "newPart" && <input aria-label="Part label" className="rounded-md bg-muted px-3 py-2" placeholder="Part label, e.g. (b) or (ii)" value={label} onChange={e => setLabel(e.target.value)} maxLength={80} />}
    </div>
    {(error || query.error) && <p role="alert" className="mt-3 text-sm text-destructive">{error || query.error?.message}</p>}
    <div className="mt-4 flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" disabled={busy || query.isLoading || !!query.error || (kind !== "newQuestion" && !choice) || (kind === "newPart" && !label.trim())} onClick={() => void save()}>{busy ? "Saving…" : kind === "newQuestion" ? "Create question" : kind === "newPart" ? "Create part" : "Add crop"}</Button></div>
  </section>;
}
