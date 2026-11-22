import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { isNativeHost, postNativeEvent } from "@/lib/backend";
import { useSyncedImageUrl } from "@/lib/synced-image";
import { partOutline, questionLabel, type Bank } from "@/lib/question-bank";
import type { WorksheetRevision } from "@/lib/worksheets";
import { answerKey, useWorksheetAnswers } from "@/lib/worksheet-session";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { IconTooltip } from "./ui/icon-tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { WorksheetAnswerEditor } from "./worksheet-answer-editor";
import { ownPartLabel, questionCropClass, questionHeadingClass, questionReadingLayout, questionReadingWidth } from "./question-reading-layout";
import { cn } from "@/lib/utils";
import { WORKSHEET_ACTIONS_SLOT, WORKSHEET_CRUMB_SLOT } from "@/lib/pdf-pane";

// Validate before walking: missing or cyclic historical content must not crash
// the whole bank, and must never silently fall back to the latest revision.
function pinnedOutline(revision: WorksheetRevision | undefined, label: string) {
  if (!revision?.parts[revision.rootPartId]) return null;
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    return Object.entries(revision.parts).filter(([, part]) => part.parentId === id).every(([child]) => visit(child));
  };
  if (!visit(revision.rootPartId) || visited.size !== Object.keys(revision.parts).length) return null;
  return partOutline(revision, label);
}
// Bank strings are display XML, never editor input. Empty rich paragraphs do
// not count as answers; loaded local drafts carry exact semantic content flags.
function savedHasContent(text: string) {
  if (!text.trim()) return false;
  const xml = new DOMParser().parseFromString(`<answer>${text}</answer>`, "application/xml");
  if (xml.querySelector("parsererror")) return true; // legacy literal plain text
  return !!xml.documentElement.textContent?.trim() || !!xml.querySelector("image, inlineImage, horizontalRule, mention, pdfTextQuote");
}
export function worksheetProgress(bank: Bank, attemptId: string, drafts: Record<string, { text: string; hasContent?: boolean }> = {}) {
  let total = 0; let answered = 0;
  for (const pin of bank.attempts[attemptId]?.questions ?? []) {
    for (const part of pinnedOutline(bank.revisions[pin.revisionId], "") ?? []) if (part.leaf) {
      total++;
      const key = answerKey(attemptId, pin.revisionId, part.id);
      if ((drafts[key]?.hasContent ?? savedHasContent(drafts[key]?.text ?? bank.answers[key]?.text ?? "")) || Object.values(bank.answers[key]?.canvases ?? {}).some(canvas => canvas.revision || canvas.copies.length)) answered++;
    }
  }
  return { total, answered };
}
function WorksheetCropImage({ assetId, label }: { assetId: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const image = useSyncedImageUrl("bank-image", assetId);
  if (failed || image.isError) return <p role="alert" className="text-sm text-destructive">Question crop unavailable on this device.</p>;
  return image.data ? <figure className="relative w-fit max-w-full"><img src={image.data} alt={label} className={questionCropClass} onError={() => setFailed(true)} /></figure> : <p className="text-sm text-muted-foreground">Loading question crop…</p>;
}
export function WorksheetAttempt({ moduleId, attemptId, bank, onBack }: { moduleId: string; attemptId: string; bank: Bank; onBack: () => void }) {
  const answers = useWorksheetAnswers(moduleId, attemptId);
  const [index, setIndex] = useState(0);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const attempt = bank.attempts[attemptId];
  const [confirmFinish, setConfirmFinish] = useState(false);
  // Desktop puts the worksheet's title and controls in the window header (the
  // root layout's slots); iPad/iPhone show them in the native toolbar instead.
  const [slots, setSlots] = useState<{ crumb: HTMLElement | null; actions: HTMLElement | null }>({ crumb: null, actions: null });
  useEffect(() => {
    if (!isNativeHost()) setSlots({ crumb: document.getElementById(WORKSHEET_CRUMB_SLOT), actions: document.getElementById(WORKSHEET_ACTIONS_SLOT) });
  }, []);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState("");
  const finished = attempt?.finished === true;
  const finish = async () => {
    if (finishing) return;
    setFinishing(true); setFinishError("");
    try {
      // Retained native drawing drafts must be published or discarded first.
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if ((key.startsWith("worksheet-inline-drawing:") || key.startsWith("worksheet-drawing:")) && key.includes(attemptId)) throw new Error("Save or discard your unsaved drawing before finishing.");
      }
      await answers.finish();
      onBack();
    } catch (cause) { setFinishError(String(cause)); }
    finally { setFinishing(false); }
  };
  const close = () => { void answers.flush(); onBack(); };
  const progress = worksheetProgress(bank, attemptId, answers.values);
  const pending = Object.keys(answers.drafts).length > 0;
  const nativeStatus = answers.error ? "Save failed" : "";
  const questionCount = attempt?.questions.length ?? 0;
  // The bank's own names (A1, B4…), falling back to the position like the bank does.
  const bankOrder = Object.entries(bank.questions).filter(([, question]) => !question.deleted)
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0])).map(([id]) => id);
  const questionLabels = (attempt?.questions ?? []).map((question, number) => {
    const position = bankOrder.indexOf(question.questionId);
    return questionLabel(bank.questions[question.questionId]?.title, position >= 0 ? position + 1 : number + 1);
  });
  const labelsKey = questionLabels.join("\n");
  const currentIndex = Math.min(index, Math.max(0, questionCount - 1));
  const actions = useRef({ close, finish: () => setConfirmFinish(true), retry: () => { void answers.flush(); } });
  actions.current = { close, finish: () => { if (!finished) setConfirmFinish(true); }, retry: () => { void answers.flush(); } };
  useEffect(() => {
    if (!isNativeHost()) return;
    const back = () => actions.current.close();
    const finish = () => actions.current.finish();
    const retry = () => actions.current.retry();
    const question = (event: Event) => {
      const next = Number((event as CustomEvent).detail);
      if (Number.isInteger(next) && next >= 0) setIndex(next);
    };
    window.addEventListener("worksheet-question", question);
    window.addEventListener("worksheet-back", back);
    window.addEventListener("worksheet-finish", finish);
    window.addEventListener("worksheet-retry", retry);
    return () => {
      window.removeEventListener("worksheet-question", question);
      window.removeEventListener("worksheet-back", back);
      window.removeEventListener("worksheet-finish", finish);
      window.removeEventListener("worksheet-retry", retry);
      postNativeEvent("worksheetState", { title: null, answered: 0, total: 0, status: "", index: 0, count: 0 });
    };
  }, []);
  useEffect(() => {
    if (isNativeHost()) postNativeEvent("worksheetState", { title: attempt?.title || "Worksheet", answered: progress.answered, total: progress.total, status: nativeStatus, finished, index: currentIndex, count: questionCount, labels: questionLabels });
  }, [attempt?.title, progress.answered, progress.total, nativeStatus, finished, currentIndex, questionCount, labelsKey]);
  if (!attempt || attempt.deleted) return <section className="space-y-3"><Button variant="ghost" onClick={close}>Back to questions</Button><p role="alert">This worksheet is unavailable.</p></section>;
  const pin = attempt.questions[currentIndex];
  const revision = pin && bank.revisions[pin.revisionId];
  const label = pin ? questionLabels[currentIndex] : "";
  const outline = pinnedOutline(revision, label);
  const answerEditor = (partId: string, partLabel: string) => {
    const key = answerKey(attemptId, pin!.revisionId, partId);
    return <WorksheetAnswerEditor readOnly={finished || finishing} moduleId={moduleId} attemptId={attemptId} revisionId={pin!.revisionId} leafPartId={partId} answer={bank.answers[key]}
      flushDurable={() => answers.flushDurable(pin!.revisionId, partId)} key={`${moduleId}:${key}:text:${answers.resets[key] || 0}`} label={partLabel}
      load={() => answers.loadDocument(pin!.revisionId, partId)} save={(document, expected, text, hasContent) => answers.setDocument(pin!.revisionId, partId, document, expected, text, hasContent)} flush={() => { void answers.flush(); }} />;
  };
  return <section aria-label={attempt.title || "Worksheet"} className={cn(questionReadingWidth, "question-bank-page space-y-5")}>
    <Dialog open={confirmFinish} onOpenChange={open => { if (!finishing) setConfirmFinish(open); }}>
      <DialogContent><DialogTitle>Finish worksheet?</DialogTitle>
        <p className="text-sm text-muted-foreground">Answers become read-only.</p>
        {finishError && <p role="alert" className="text-sm text-destructive">{finishError}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={finishing} onClick={() => setConfirmFinish(false)}>Cancel</Button><Button disabled={finishing} onClick={() => void finish()}>{finishing ? "Finishing…" : "Finish"}</Button></div>
      </DialogContent>
    </Dialog>
    {slots.crumb && createPortal(<div className="flex min-w-0 items-center gap-0.5">
      <IconTooltip label="Back to questions"><Button size="icon-sm" variant="ghost" aria-label="Back to questions" onClick={close}><ChevronLeft /></Button></IconTooltip>
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground" data-tauri-drag-region="deep">{attempt.title || "Worksheet"}</h2>
    </div>, slots.crumb)}
    {slots.actions && createPortal(<div className="flex items-center gap-1">
      {answers.saving || pending ? <span role="status" className="mr-1 text-xs text-muted-foreground">Saving…</span> : null}
      {answers.error && <IconTooltip label="Save failed. Retry"><Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="Save failed. Retry" onClick={() => void answers.flush()}><AlertTriangle /></Button></IconTooltip>}
      {questionCount > 0 && <nav aria-label="Worksheet questions" className="flex items-center gap-0.5">
        <IconTooltip label="Previous question"><Button size="icon-xs" variant="ghost" aria-label="Previous question" disabled={currentIndex === 0} onClick={() => setIndex(currentIndex - 1)}><ChevronLeft /></Button></IconTooltip>
        {questionCount <= 3 ? attempt.questions.map((question, number) => <Button key={`${question.revisionId}:${number}`} size="xs" className="min-w-6 px-1.5 tabular-nums" variant={number === currentIndex ? "default" : "ghost"} aria-label={`Question ${questionLabels[number]}`} aria-current={number === currentIndex ? "step" : undefined} onClick={() => setIndex(number)}>{questionLabels[number]}</Button>)
          : <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="xs" variant="ghost" className="gap-1 tabular-nums" aria-label="Choose question"><span className="font-semibold">{questionLabels[currentIndex]}</span><span className="text-muted-foreground">{currentIndex + 1}/{questionCount}</span><ChevronDown className="size-3" /></Button>} />
            <DropdownMenuContent align="end" className="max-h-80 min-w-36">
              <DropdownMenuRadioGroup value={String(currentIndex)} onValueChange={value => setIndex(Number(value))}>
                {attempt.questions.map((question, number) => <DropdownMenuRadioItem key={`${question.revisionId}:${number}`} value={String(number)} showIndicator={false} closeOnClick>Question {questionLabels[number]}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>}
        <IconTooltip label="Next question"><Button size="icon-xs" variant="ghost" aria-label="Next question" disabled={currentIndex + 1 >= questionCount} onClick={() => setIndex(currentIndex + 1)}><ChevronRight /></Button></IconTooltip>
      </nav>}
      {finished ? <IconTooltip label="Close worksheet"><Button size="icon-xs" variant="ghost" aria-label="Close worksheet" onClick={close}><X /></Button></IconTooltip>
        : <Button size="xs" className="ml-1 rounded-full px-3" disabled={finishing} onClick={() => setConfirmFinish(true)}>Finish</Button>}
    </div>, slots.actions)}
    <header className="space-y-2 empty:hidden">
      {answers.error && <p role="alert" className="text-sm text-destructive">{answers.error} Your draft is retained.</p>}
      {answers.backupError && <p role="alert" className="text-sm text-destructive">{answers.backupError}</p>}
    </header>
    {!pin ? <p role="alert">This worksheet has no questions.</p> : !outline || !revision || revision.questionId !== pin.questionId ? <p role="alert" className="text-sm text-destructive">The pinned question revision is unavailable. Return to questions and try reopening the worksheet.</p> : <article aria-label={`Question ${label}`}>
      {outline.map((part, partIndex) => {
        const key = answerKey(attemptId, pin.revisionId, part.id);
        const foldKey = JSON.stringify([moduleId, key]);
        const collapsed = folded.has(foldKey);
        const root = part.depth === 0;
        const cropIds = revision.parts[part.id].cropIds;
        const layout = questionReadingLayout(part.depth, collapsed, cropIds.length > 0);
        const descendants = outline.slice(partIndex + 1);
        const end = descendants.findIndex(child => child.depth <= part.depth);
        const parts = descendants.slice(0, end < 0 ? undefined : end).filter(child => child.depth === part.depth + 1).length;
        const toggle = () => {
          void answers.flush();
          setFolded(current => { const next = new Set(current); if (next.has(foldKey)) next.delete(foldKey); else next.add(foldKey); return next; });
        };
        // Keep editors mounted: hiding a subtree must not drop IME input, Yjs
        // bindings, selection or an in-flight drawing/save operation.
        let hidden = false;
        let ancestorDepth = part.depth;
        for (let i = partIndex - 1; i >= 0 && ancestorDepth > 0; i--) {
          const ancestor = outline[i];
          if (ancestor.depth >= ancestorDepth) continue;
          ancestorDepth = ancestor.depth;
          if (folded.has(JSON.stringify([moduleId, answerKey(attemptId, pin.revisionId, ancestor.id)]))) hidden = true;
        }
        return <section key={foldKey} hidden={hidden} className={layout.partClass} style={{ marginLeft: layout.marginLeft, display: hidden ? "none" : undefined }}>
          <h3 className={cn(questionHeadingClass, "worksheet-question-heading")}>
            <span className="bank-disclosure flex h-7 w-4 shrink-0 items-center justify-center"><button type="button" className="text-muted-foreground hover:text-foreground" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Fold"} ${part.label}`} onClick={toggle}><ChevronRight size={14} className={collapsed ? "" : "rotate-90"} /></button></span>
            <button type="button" className={cn(layout.labelClass, "worksheet-question-label")} aria-expanded={!collapsed} onClick={toggle}>{root ? label : ownPartLabel(revision.parts[part.id].label)}</button>
            {parts > 0 && collapsed && <button type="button" aria-label={`Show parts of ${part.label}`} aria-expanded={false} className="bank-part-count ml-2 flex h-7 shrink-0 items-center self-center rounded-sm text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={toggle}>{parts} {parts === 1 ? "part" : "parts"}</button>}
          </h3>
          <div hidden={collapsed} className={layout.contentClass}>
          {cropIds.map(cropId => {
            const crop = revision.crops[cropId];
            return crop ? <WorksheetCropImage key={`${cropId}:${crop.assetId}`} assetId={crop.assetId} label={`Question ${part.label}`} /> : <p key={cropId} role="alert" className="text-sm text-destructive">A pinned question crop is unavailable.</p>;
          })}
          {!cropIds.length && !root && <p className="py-1 text-sm text-muted-foreground">No crops yet</p>}
          {part.leaf && <>
            {answerEditor(part.id, part.label)}
            {answers.errors[key] && <p role="alert" className="text-sm text-destructive">Couldn't save: {answers.errors[key]} <Button size="sm" variant="ghost" disabled={answers.saving} onClick={() => void answers.retryAnswer(pin.revisionId, part.id)}>Retry</Button><Button size="sm" variant="ghost" disabled={answers.saving} onClick={() => answers.discardAnswer(pin.revisionId, part.id)}>Discard</Button></p>}
          </>}
          </div>
        </section>;
      })}
    </article>}
  </section>;
}
