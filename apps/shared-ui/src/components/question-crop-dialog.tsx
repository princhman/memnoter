import { useEffect, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { questionLabel, nextQuestionLabel, setBankTarget, useBankTarget, nextPartLabel, partOutline, useBank, useBankEdit, type Bank, type CropDraft, type BankEdit } from "@/lib/question-bank";
import { Button } from "./ui/button";
import { isNativeHost } from "@/lib/backend";
import { Kbd } from "./ui/kbd";

type Choice = { key: string; label: string; edit: Omit<Exclude<BankEdit, { kind: "nestQuestion" }>, "crop"> };

// What the crop can become, worded from where the user is in the worksheet:
// the next question, the next part at the current level, a sub-part of the
// current part, or more of the current question/part.
function choices(bank: Bank | null | undefined, target: { questionId: string; partId: string } | null): Choice[] {
  const live = Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  const result: Choice[] = [{ key: "q", label: `Question ${nextQuestionLabel(bank)}`, edit: { kind: "newQuestion" } }];
  const index = target ? live.findIndex(([id]) => id === target.questionId) : -1;
  if (!bank || index < 0) return result;
  const question = live[index][1]; const revision = bank.revisions[question.revisionId];
  const part = revision.parts[target!.partId];
  if (!part) return result;
  const outline = partOutline(revision, questionLabel(live[index][1].title, index + 1));
  const name = (id: string) => outline.find(p => p.id === id)?.label ?? "";
  const pin = { questionId: target!.questionId, expectedRevisionId: question.revisionId };
  const siblingParent = part.parentId ?? target!.partId;
  const sibling = nextPartLabel(revision, siblingParent);
  result.push({ key: "p", label: `Part ${name(siblingParent)}(${sibling})`, edit: { kind: "newPart", ...pin, partId: siblingParent, label: sibling } });
  if (part.parentId) {
    const child = nextPartLabel(revision, target!.partId);
    result.push({ key: "s", label: `Sub-part ${name(target!.partId)}(${child})`, edit: { kind: "newPart", ...pin, partId: target!.partId, label: child } });
  }
  result.push({ key: "a", label: `Add to ${name(target!.partId)}`, edit: { kind: "addCrop", ...pin, partId: target!.partId } });
  return result;
}

// Every question and part, named as the bank names them, to pick a target from.
function targets(bank: Bank | null | undefined) {
  return Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .flatMap(([questionId, question], index) => partOutline(bank!.revisions[question.revisionId], questionLabel(question.title, index + 1)).map(part => ({ questionId, partId: part.id, label: part.label, depth: part.depth })));
}

export function QuestionCropDialog({ moduleId, draft, onClose, onSaved }: { moduleId: string; draft: CropDraft; onClose: () => void; onSaved?: () => void }) {
  const query = useBank(moduleId, true); const edit = useBankEdit(moduleId);
  const target = useBankTarget(moduleId, query.data);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const options = choices(query.data, target);
  const list = picking ? targets(query.data) : [];
  const targetName = target ? targets(query.data).find(t => t.partId === target.partId && t.questionId === target.questionId)?.label : undefined;
  const save = async (choice: Choice) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const bytes = [...new Uint8Array(await draft.blob.arrayBuffer())];
      const crop = { sourcePdfFileId: draft.sourcePdfFileId, pageIndex: draft.pageIndex, rect: draft.rect, rotation: draft.rotation, pixelSize: draft.pixelSize, bytes };
      await edit({ ...choice.edit, crop }); onClose(); onSaved?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); await query.refetch(); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable=true]")) return;
      if (event.key === "Escape") { event.preventDefault(); if (picking) setPicking(false); else onClose(); return; }
      const choice = options.find(o => o.key === event.key.toLowerCase());
      if (choice && !query.isLoading) { event.preventDefault(); void save(choice); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  return <section role="dialog" aria-label="Add crop to question bank" className="question-crop-bar absolute inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl items-center gap-3 rounded-xl floating-surface bg-popover p-2 text-popover-foreground shadow-lg">
    {picking && <ul aria-label="Choose where crops go" className="absolute inset-x-0 bottom-full mb-1 max-h-56 overflow-y-auto rounded-xl floating-surface bg-popover p-1 shadow-lg">
      {list.map(item => <li key={`${item.questionId}:${item.partId}`}><button type="button" style={{ paddingLeft: 8 + item.depth * 12 }} aria-current={item.questionId === target?.questionId && item.partId === target.partId} className="w-full rounded-md py-1 pr-2 text-left text-sm hover:bg-accent aria-[current=true]:font-semibold" onClick={() => { setBankTarget({ moduleId, questionId: item.questionId, partId: item.partId }); setPicking(false); }}>{item.label}</button></li>)}
    </ul>}
    <img src={draft.url} alt="Selected crop" className="h-12 w-16 shrink-0 rounded bg-white object-contain" />
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {targetName && <Button size="xs" variant="outline" aria-expanded={picking} aria-label={`Target ${targetName}, change`} onClick={() => setPicking(open => !open)}>{targetName}<ChevronsUpDown className="size-3 opacity-60" /></Button>}
      {options.map(choice => <Button key={choice.key} size="xs" variant={choice.key === "a" ? "secondary" : "ghost"} disabled={busy || query.isLoading || !!query.error} onClick={() => void save(choice)}>{choice.label}{!isNativeHost() && <Kbd>{choice.key.toUpperCase()}</Kbd>}</Button>)}
      {(error || query.error) && <p role="alert" className="w-full px-2 text-xs text-destructive">{error || query.error?.message}</p>}
    </div>
    <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={onClose}>Discard{!isNativeHost() && <Kbd>Esc</Kbd>}</Button>
  </section>;
}
