import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { questionLabel, bankTarget, nextPartLabel, partOutline, useBank, useBankEdit, type Bank, type CropDraft, type BankEdit } from "@/lib/question-bank";
import { Button } from "./ui/button";

type Choice = { key: string; label: string; edit: Omit<BankEdit, "crop"> };

// What the crop can become, worded from where the user is in the worksheet:
// the next question, the next part at the current level, a sub-part of the
// current part, or more of the current question/part.
function choices(bank: Bank | null | undefined, target: { questionId: string; partId: string } | null): Choice[] {
  const live = Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order);
  const result: Choice[] = [{ key: "q", label: `Question ${live.length + 1}`, edit: { kind: "newQuestion", title: "" } }];
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

export function QuestionCropDialog({ moduleId, draft, onClose, onSaved }: { moduleId: string; draft: CropDraft; onClose: () => void; onSaved?: () => void }) {
  const query = useBank(moduleId, true); const edit = useBankEdit(moduleId);
  const target = useSelector(bankTarget, s => s?.moduleId === moduleId ? s : null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const options = choices(query.data, target);
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
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      const choice = options.find(o => o.key === event.key.toLowerCase());
      if (choice && !query.isLoading) { event.preventDefault(); void save(choice); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  return <section role="dialog" aria-label="Add crop to question bank" className="absolute inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl items-center gap-3 rounded-xl floating-surface bg-popover p-2 text-popover-foreground shadow-lg">
    <img src={draft.url} alt="Selected crop" className="h-12 w-16 shrink-0 rounded bg-white object-contain" />
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {options.map(choice => <Button key={choice.key} size="xs" variant={choice.key === "a" ? "secondary" : "ghost"} disabled={busy || query.isLoading || !!query.error} onClick={() => void save(choice)}>{choice.label}<kbd className="ml-1 font-sans text-[10px] text-muted-foreground">{choice.key.toUpperCase()}</kbd></Button>)}
      {(error || query.error) && <p role="alert" className="w-full px-2 text-xs text-destructive">{error || query.error?.message}</p>}
    </div>
    <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={onClose}>Discard<kbd className="ml-1 font-sans text-[10px]">Esc</kbd></Button>
  </section>;
}
