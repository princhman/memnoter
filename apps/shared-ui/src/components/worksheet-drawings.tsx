import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { call, fileUrl, isTauri } from "@/lib/backend";
import { IS_MAC } from "@/lib/platform";
import { bankKey, type Bank } from "@/lib/question-bank";
import { queryClient } from "@/lib/query-client";
import { answerKey } from "@/lib/worksheet-session";
import { assertWritable, writeOperation, type WritePermit } from "@/lib/write-lifecycle";
import type { FileType } from "@/lib/content";
import { Button } from "./ui/button";

type Result = { status: string; source?: FileType; preview?: FileType; width?: number; height?: number; expectedSourceId?: string | null; asCopy: boolean; hasChanges: boolean };
type Pending = { canvasId: string; sourceId: string | null; result?: Result; attached?: boolean };
function Preview({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  const image = useQuery({ queryKey: ["worksheet-drawing", id], queryFn: () => call<string>("resolve_card_image", { fileId: id }).then(fileUrl), staleTime: Infinity, retry: false });
  return failed || image.isError ? <div role="alert" className="text-sm text-destructive">Drawing preview unavailable. <Button size="sm" variant="ghost" onClick={() => { setFailed(false); void image.refetch(); }}>Retry preview</Button></div>
    : image.data ? <img className="max-h-96 max-w-full rounded-sm bg-white object-contain" src={image.data} alt="Answer drawing" onError={() => setFailed(true)} /> : <p className="text-sm text-muted-foreground">Loading drawing…</p>;
}
export function WorksheetDrawings({ moduleId, attemptId, revisionId, leafPartId, answer, inlineSources = [], readOnly = false }: { moduleId: string; attemptId: string; revisionId: string; leafPartId: string; answer?: Bank["answers"][string]; inlineSources?: string[]; readOnly?: boolean }) {
  const key = answerKey(attemptId, revisionId, leafPartId);
  const storageKey = `worksheet-drawing:${moduleId}:${key}`;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "null");
      return value && typeof value.canvasId === "string" && (value.sourceId === null || typeof value.sourceId === "string") ? value : null;
    } catch { return null; }
  });
  const supported = !readOnly && IS_MAC && isTauri();
  const answerRef = useRef(answer);
  answerRef.current = answer;
  const running = useRef(false);
  const clear = () => {
    setPending(null); setError(""); localStorage.removeItem(storageKey);
  };
  const wasRemoved = (draft: Pending) => (draft.attached ?? draft.sourceId !== null) && !answerRef.current?.canvases[draft.canvasId];
  const forgetRemoved = (draft: Pending) => {
    clear();
    void call("drawing_committed", { moduleId, imageId: draft.canvasId }).catch(() => {});
  };
  useEffect(() => {
    // Legacy canvas recovery owns a canvas, not an inline image. A removed
    // published owner must never be recreated by retrying its native receipt.
    if (pending && wasRemoved(pending)) forgetRemoved(pending);
  }, [answer, pending]);
  const retain = (value: Pending) => {
    // Save the owner before opening native UI: its on-disk draft uses this ID.
    localStorage.setItem(storageKey, JSON.stringify(value));
    setPending(value);
  };
  const save = async (draft: Pending, admittedPermit?: WritePermit) => {
    if (wasRemoved(draft)) { forgetRemoved(draft); return; }
    const result = draft.result!;
    if (!result.source || !result.preview || !result.width || !result.height) throw new Error("The native drawing save was incomplete. Reopen the local draft to continue.");
    const attach = async (permit: WritePermit) => {
      assertWritable(permit);
      const receipt = await call<{ bank: Bank }>("worksheet_canvas_save", { moduleId, attemptId, revisionId, leafPartId,
        canvasId: draft.canvasId, sourceId: result.source!.id, previewId: result.preview!.id,
        expectedSourceId: result.expectedSourceId ?? null, width: result.width, height: result.height, asCopy: result.asCopy });
      const saved = receipt.bank.answers[key];
      const canvas = saved?.canvases[draft.canvasId];
      if (!canvas || ![canvas.revision, ...canvas.copies].some(ink => ink?.sourceId === result.source!.id && ink.previewId === result.preview!.id)) throw new Error("The drawing reference was not acknowledged. Your local draft is retained.");
      queryClient.setQueryData<Bank | null>(bankKey(moduleId), current => {
        if (!current) return receipt.bank;
        const previous = current.answers[key];
        return { ...current, answers: { ...current.answers, [key]: previous ? { ...previous,
          canvases: { ...previous.canvases, [draft.canvasId]: canvas },
          canvasOrder: previous.canvasOrder.includes(draft.canvasId) ? previous.canvasOrder : [...previous.canvasOrder, draft.canvasId],
        } : saved } };
      });
      // The native checkpoint is cleared only after the durable reference receipt.
      await call("drawing_committed", { moduleId, imageId: draft.canvasId });
      clear();
    };
    if (admittedPermit) await attach(admittedPermit);
    else await writeOperation(attach);
  };
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(`${cause instanceof Error ? cause.message : String(cause)} Your local drawing draft is retained; retry saving or reopen it.`); }
    finally { running.current = false; setBusy(false); }
  };
  const open = (draft: Pending) => run(async () => {
    if (wasRemoved(draft)) { forgetRemoved(draft); return; }
    draft = { ...draft, attached: draft.attached ?? !!answerRef.current?.canvases[draft.canvasId] };
    retain(draft);
    await writeOperation(async permit => {
      assertWritable(permit);
      const result = await call<Result>("edit_drawing", { moduleId, imageId: draft.canvasId, sourceId: draft.sourceId });
      assertWritable(permit);
      if (wasRemoved(draft)) { forgetRemoved(draft); return; }
      if (result.status === "save") {
        const updated = { ...draft, result };
        // Keep the receipt in memory even if localStorage becomes unavailable.
        setPending(updated);
        retain(updated);
        await save(updated, permit);
      } else if (result.status === "discarded" || result.status === "empty" || (result.status === "cancel" && !result.hasChanges) || result.status === "unchanged") {
        clear();
      }
    });
  });
  return <div className="space-y-3">
    {(answer?.canvasOrder ?? []).map(id => {
      const canvas = answer!.canvases[id];
      if (!canvas) return null;
      const revisionVisible = canvas.revision && !inlineSources.includes(canvas.revision.sourceId);
      const copies = canvas.copies.filter(ink => !inlineSources.includes(ink.sourceId));
      if (!revisionVisible && !copies.length) return null;
      return <div key={id} className="space-y-2">
        {revisionVisible && canvas.revision && <Preview key={canvas.revision.previewId} id={canvas.revision.previewId} />}
        {copies.map(ink => <div key={ink.sourceId} className="space-y-1"><span className="text-xs text-muted-foreground">Saved copy</span><Preview id={ink.previewId} /></div>)}
        {supported && <Button size="sm" variant="ghost" disabled={busy || !!pending} onClick={() => void open({ canvasId: id, sourceId: canvas.revision?.sourceId ?? null })}>Edit drawing</Button>}
      </div>;
    })}
    {supported ? <div className="flex flex-wrap gap-2">
      {pending && !wasRemoved(pending) ? <>
        {pending.result && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => save(pending))}>Retry drawing save</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open({ ...pending, result: undefined })}>Reopen local drawing</Button>
      </> : null}
      {busy && <span role="status" className="text-sm text-muted-foreground">Saving drawing…</span>}
    </div> : null}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
