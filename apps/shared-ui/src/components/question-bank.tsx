import { useDocuments } from "@/lib/use-documents";
import { ToolButton } from "@/components/ui/tool-button";
import { ImageActionsMenu, ImagePreviewDialog } from "@/components/image-actions-menu";
import { updatePdfPane, requestPdfPage, setWorksheetOpen } from "@/lib/pdf-pane";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ArrowDown, ArrowUp, ArrowUpDown, Crop, FilePlus2, Maximize2, Ellipsis, GripVertical, FileText, Pencil, Trash2 } from "lucide-react";
import { DndContext, DragOverlay, MeasuringStrategy, PointerSensor, useDndContext, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { call, fileUrl, isNativeHost, postNativeEvent } from "@/lib/backend";
import { nextPartLabel, questionLabel, setBankTarget, useBankTarget, partOutline, useBank, useBankEdit, type BankEdit, type Bank } from "@/lib/question-bank";
import { cn } from "@/lib/utils";
import { CropDialog, type Crop as CropBox } from "./image-crop-dialog";
import type { WorksheetCrop } from "@/lib/worksheets";
import { Button } from "./ui/button";
import { WorksheetAttempt } from "./worksheet-attempt";
import { ownPartLabel as own, questionCropClass, questionHeadingClass, questionReadingLayout, questionReadingWidth } from "./question-reading-layout";
import { useCreateWorksheet } from "@/lib/worksheet-session";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "./ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import "./saved-image.css";
import "./question-bank.css";

function CropImage({ id, alt, onLoad }: { id: string; alt: string; onLoad: (image: HTMLImageElement) => void }) {
  const { data, isError } = useQuery({ queryKey: ["bank-image", id], queryFn: () => call<string>("resolve_card_image", { fileId: id }).then(fileUrl), retry: false, staleTime: Infinity });
  return data ? <img className={questionCropClass} src={data} alt={alt} onLoad={event => onLoad(event.currentTarget)} /> : <p className="rounded-md bg-muted p-5 text-sm text-muted-foreground">{isError ? "Crop unavailable on this device" : "Loading…"}</p>;
}

type ReplacementCrop = NonNullable<BankEdit["crop"]>;

function BankCrop({ moduleId, crop, alt, disabled, onTrim, children }: { moduleId: string; crop: WorksheetCrop; alt: string; disabled: boolean; onTrim: (crop: ReplacementCrop) => Promise<void>; children: React.ReactNode }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [trimming, setTrimming] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Touch has no hover: like note images, a crop shows its "…" only once tapped.
  const [selected, setSelected] = useState(false);
  const figure = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    const deselect = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (figure.current?.contains(target) || target?.closest("[data-slot='dropdown-menu-content'], [role='dialog']")) return;
      setSelected(false);
    };
    document.addEventListener("pointerdown", deselect, true);
    return () => document.removeEventListener("pointerdown", deselect, true);
  }, [selected]);
  const save = async (box: CropBox) => {
    if (!image?.naturalWidth || !image.naturalHeight) throw new Error("The crop image has not loaded yet.");
    const file = await call<{ bytes: number[]; file_type: string }>("read_file", { moduleId, fileId: crop.assetId });
    const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.file_type }));
    try {
      const source = new Image(); source.src = url; await source.decode();
      const width = source.naturalWidth; const height = source.naturalHeight;
      const left = Math.max(0, Math.min(width - 1, Math.round(box.x * width)));
      const top = Math.max(0, Math.min(height - 1, Math.round(box.y * height)));
      const right = Math.max(left + 1, Math.min(width, Math.round((box.x + box.width) * width)));
      const bottom = Math.max(top + 1, Math.min(height, Math.round((box.y + box.height) * height)));
      const canvas = document.createElement("canvas"); canvas.width = right - left; canvas.height = bottom - top;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare the cropped image.");
      context.drawImage(source, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not save the cropped image.")), "image/png"));
      const [x, y, w, h] = crop.rect;
      const nextX = x + w * left / width; const nextY = y + h * top / height;
      await onTrim({ sourcePdfFileId: crop.sourcePdfFileId, pageIndex: crop.pageIndex, rotation: crop.rotation,
        rect: [nextX, nextY, Math.min(x + w, x + w * right / width) - nextX, Math.min(y + h, y + h * bottom / height) - nextY],
        pixelSize: [canvas.width, canvas.height], bytes: [...new Uint8Array(await blob.arrayBuffer())] });
      setTrimming(false);
    } finally { URL.revokeObjectURL(url); }
  };
  return <figure ref={figure} data-selected={selected || undefined} className="group/crop relative w-fit max-w-full" onClick={event => { if (!(event.target as Element).closest("button")) setSelected(true); }}>
    <CropImage id={crop.assetId} alt={alt} onLoad={setImage} />
    <div className="absolute right-1 top-1 opacity-0 group-hover/crop:opacity-100 focus-within:opacity-100 has-data-open:opacity-100">
      <ImageActionsMenu label="Crop actions" className="bank-crop-menu w-60 max-w-[calc(100vw-2rem)]">
        <DropdownMenuItem disabled={!image} onClick={() => setPreviewOpen(true)}><Maximize2 />Open image full screen</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabled || !image} onClick={() => setTrimming(true)}><Crop />Trim crop</DropdownMenuItem>
        {children}
      </ImageActionsMenu>
    </div>
    <ImagePreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} src={image?.src} alt={alt} />
    {trimming && image && <CropDialog image={image} onCancel={() => setTrimming(false)} onSave={save} />}
  </figure>;
}

type BankDrag = { moduleId: string; rowPartId: string; parentId: string | null; subtreeIds: string[]; folded: boolean; childCount: number; nextChildLabel: string; group: string; label: string; index: number; questionId: string; partId?: string; expectedRevisionId: string; endId: string; preview: { label: string; depth: number }[] };
type DropEdge = "before" | "inside" | "after";
type DropPlan = { edit: BankEdit; cue: string; inside: boolean };
function dropPlan(source: BankDrag, target: BankDrag, edge: DropEdge): DropPlan | null {
  if (source.moduleId !== target.moduleId || (source.questionId === target.questionId && source.subtreeIds.includes(target.rowPartId))) return null;
  const pin = { questionId: source.questionId, partId: source.partId, expectedRevisionId: source.expectedRevisionId };
  if (!source.partId) {
    if (edge === "inside") return {
      edit: { kind: "nestQuestion", questionId: source.questionId, expectedRevisionId: source.expectedRevisionId,
        targetQuestionId: target.questionId, targetParentId: target.rowPartId,
        expectedTargetRevisionId: target.expectedRevisionId, label: target.nextChildLabel, index: target.childCount },
      cue: `Make ${source.label} a part of ${target.label}`, inside: true,
    };
    if (target.partId) return null;
    const insertion = target.index + (edge === "after" ? 1 : 0);
    const index = insertion - (source.index < insertion ? 1 : 0);
    return index === source.index ? null : { edit: { kind: "moveQuestion", ...pin, index }, cue: `${edge === "before" ? "Before" : "After"} ${target.label}`, inside: false };
  }
  if (!target.partId && edge !== "inside") return {
    edit: { kind: "promotePart", ...pin, index: target.index + (edge === "after" ? 1 : 0) },
    cue: `New question ${edge} ${target.label.replace(/^Question /, "")}`, inside: false,
  };
  const parent = edge === "inside" ? target.rowPartId : target.parentId!;
  const sameParent = source.questionId === target.questionId && source.parentId === parent;
  const insertion = edge === "inside" ? target.childCount : target.index + (edge === "after" ? 1 : 0);
  const index = insertion - (sameParent && source.index < insertion ? 1 : 0);
  if (sameParent && index === source.index) return null;
  return {
    edit: { kind: source.questionId === target.questionId ? "reparentPart" : "transferPart", ...pin,
      targetQuestionId: target.questionId, targetParentId: parent, expectedTargetRevisionId: target.expectedRevisionId, index },
    cue: edge === "inside" ? `Inside ${target.label}` : `${edge === "before" ? "Before" : "After"} ${target.label}`,
    inside: edge === "inside",
  };
}
type RowAction = { label: string; icon: React.ReactNode; disabled?: boolean; destructive?: boolean; run: () => void };

// Drag the row, including its label; controls and text fields keep their own
// pointer behaviour. The movement threshold preserves clicks and double-clicks.
function BankRow({ id, data, disabled, actions, children }: { id: string; data: BankDrag; disabled: boolean; actions: RowAction[]; children: React.ReactNode }) {
  const native = isNativeHost();
  const drag = useDraggable({ id, data, disabled });
  const drop = useDroppable({ id, data, disabled });
  const { active, collisions, droppableRects } = useDndContext();
  const edge = collisions?.[0]?.data?.edge as DropEdge | undefined;
  const plan = collisions?.[0]?.data?.plan as DropPlan | undefined;
  const markerY = collisions?.[0]?.data?.markerY as number | undefined;
  const endRect = droppableRects.get(data.endId);
  const rowRect = droppableRects.get(id);
  const showDrop = drop.isOver && active?.id !== id && !!plan;
  return <ContextMenu>
    <ContextMenuTrigger render={<div />} ref={element => { drag.setNodeRef(element); drop.setNodeRef(element); }} {...(native ? {} : drag.attributes)} role="group" aria-label={data.label} data-bank-row={id}
      onPointerDown={event => {
        if (native) return;
        const target = event.target;
        if (!(target instanceof Element) || !event.currentTarget.contains(target) || target.closest('button:not([data-bank-drag-label]), input, textarea, select, a, [contenteditable]:not([contenteditable="false"]), [role="menuitem"]')) return;
        drag.listeners?.onPointerDown?.(event);
      }}
      className={cn("bank-drag-row group/heading", questionHeadingClass, !disabled && "cursor-grab active:cursor-grabbing", showDrop && plan?.inside && "bg-primary/10")}>
      {showDrop && !plan?.inside && <span aria-hidden="true" className="bank-drop-line pointer-events-none absolute inset-x-0 h-0.5 bg-primary" style={{ left: data.partId ? 20 : 0, top: markerY !== undefined && rowRect ? markerY - rowRect.top : edge === "after" && endRect && rowRect ? endRect.bottom - rowRect.top + 2 : -3 }} />}
      {native && !disabled && <button type="button" ref={drag.setActivatorNodeRef} {...drag.attributes} {...drag.listeners} className="bank-touch-handle" aria-label={`Drag ${data.label}`}><GripVertical size={18} /></button>}
      {children}
      {native && <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="bank-row-menu" aria-label={`Actions for ${data.label}`} />}><Ellipsis /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">{actions.map(item => <DropdownMenuItem key={item.label} disabled={item.disabled} variant={item.destructive ? "destructive" : "default"} onClick={item.run}>{item.icon}{item.label}</DropdownMenuItem>)}</DropdownMenuContent>
      </DropdownMenu>}
      {showDrop && <span className="bank-drop-cue" role="status">{plan?.cue}</span>}
    </ContextMenuTrigger>
    <ContextMenuContent>{actions.map(item => <ContextMenuItem key={item.label} disabled={item.disabled} variant={item.destructive ? "destructive" : "default"} onClick={item.run}>{item.icon}{item.label}</ContextMenuItem>)}</ContextMenuContent>
  </ContextMenu>;
}

// Rename in a dialog so the field is not constrained by the part-label gutter.
function EditableLabel({ editing, value, placeholder, renameTitle, onStart, onSave, onCancel, children, ...rest }: { editing: boolean; value: string; placeholder?: string; renameTitle: string; onStart: () => void; onSave: (value: string) => void; onCancel: () => void; children: React.ReactNode } & Omit<React.ComponentProps<"button">, "onDoubleClick">) {
  const settled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const finish = (save: boolean, text: string) => { if (settled.current) return; settled.current = true; if (save) onSave(text); else onCancel(); };
  return <>
    <button type="button" title={isNativeHost() ? undefined : "Right-click to rename"} data-bank-drag-label {...rest} onDoubleClick={onStart} onKeyDown={event => { if (event.key === "F2") { event.preventDefault(); onStart(); } }}>{children}</button>
    {editing && <Dialog open onOpenChange={open => { if (!open) finish(false, ""); }}>
      <DialogContent>
        <DialogTitle>{renameTitle}</DialogTitle>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); finish(true, input.current?.value ?? value); }}>
          <input ref={input} autoFocus defaultValue={value} placeholder={placeholder} aria-label="Name" maxLength={120} className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" onFocus={event => { settled.current = false; event.currentTarget.select(); }} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => finish(false, "")}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>}
  </>;
}

// The bank reads like the worksheet it came from: each question's number, its
// shared crops, then its parts in the margin. Clicking a question or part
// makes it where the next crop goes; crop controls appear on hover.
function openWorksheet(moduleId: string) {
  try { const id = localStorage.getItem(`worksheet-open:${moduleId}`); return id ? { moduleId, id } : null; }
  catch { return null; }
}
function rememberWorksheet(moduleId: string, id: string | null) {
  try { if (id) localStorage.setItem(`worksheet-open:${moduleId}`, id); else localStorage.removeItem(`worksheet-open:${moduleId}`); }
  catch { /* Storage may be unavailable; the worksheet just won't reopen. */ }
}

export function QuestionBank({ moduleId, onOpenSource, nativeToolbar = false }: { moduleId: string; onOpenSource?: (documentId: string) => void; nativeToolbar?: boolean }) {
  const { data: savedBank, error, isLoading, refetch } = useBank(moduleId, true);
  const [pendingBank, setPendingBank] = useState<{ moduleId: string; bank: Bank; received?: boolean } | null>(null);
  const bank = pendingBank?.moduleId === moduleId ? pendingBank.bank : savedBank;
  useEffect(() => {
    // React Query may structurally share the receipt rather than preserve its
    // object identity. Match the resulting question revisions and order.
    if (pendingBank?.moduleId === moduleId && pendingBank.received && savedBank &&
      Object.keys(pendingBank.bank.questions).length === Object.keys(savedBank.questions).length &&
      Object.entries(pendingBank.bank.questions).every(([id, question]) => savedBank.questions[id]?.revisionId === question.revisionId && savedBank.questions[id]?.order === question.order && savedBank.questions[id]?.deleted === question.deleted)) setPendingBank(null);
  }, [moduleId, pendingBank, savedBank]);
  const { data: documents = [] } = useDocuments(moduleId);
  const edit = useBankEdit(moduleId);
  const createWorksheet = useCreateWorksheet(moduleId);
  const [picking, setPicking] = useState(false);
  const [selectedQuestions, setSelectedQuestions] = useState<Set<string>>(new Set());
  const [worksheetTitle, setWorksheetTitle] = useState("");
  // The open worksheet survives reloads and relaunches, per module.
  const [activeAttempt, setActiveAttemptState] = useState<{ moduleId: string; id: string } | null>(() => openWorksheet(moduleId));
  const setActiveAttempt = (next: { moduleId: string; id: string } | null) => {
    setActiveAttemptState(next);
    rememberWorksheet(moduleId, next?.moduleId === moduleId ? next.id : null);
  };
  useEffect(() => {
    if (!savedBank || !activeAttempt || activeAttempt.moduleId !== moduleId) return;
    const attempt = savedBank.attempts[activeAttempt.id];
    if (!attempt || attempt.deleted) setActiveAttempt(null);
  }, [savedBank, activeAttempt?.id, moduleId]);
  const worksheetOpen = activeAttempt?.moduleId === moduleId;
  useEffect(() => {
    setWorksheetOpen(moduleId, worksheetOpen);
    return () => setWorksheetOpen(moduleId, false);
  }, [moduleId, worksheetOpen]);
  const target = useBankTarget(moduleId, bank);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [reorderFolds, setReorderFolds] = useState<Record<string, boolean>>({});
  const section = useRef<HTMLElement>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const dropBoundary = useRef<{ id: string; edge: DropEdge; plan: DropPlan | null } | null>(null);
  const hoverOpen = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const clearHover = () => { if (hoverOpen.current) clearTimeout(hoverOpen.current.timer); hoverOpen.current = null; };
  useEffect(() => () => clearHover(), [moduleId]);
  const saving = useRef(false);
  const [dragging, setDragging] = useState<BankDrag | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [busy, setBusy] = useState(false); const [failure, setFailure] = useState("");
  const [folds, setFolds] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem("bank-folds") || "{}"); } catch { return {}; } });
  const visibleFolds = reordering ? reorderFolds : folds;
  const toggle = (key: string) => {
    if (reordering) { setReorderFolds(previous => ({ ...previous, [key]: !previous[key] })); return; }
    setFolds(previous => { const next = { ...previous, [key]: !previous[key] }; try { localStorage.setItem("bank-folds", JSON.stringify(next)); } catch {} return next; });
  };
  const questions = Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  const [allWorksheets, setAllWorksheets] = useState(false);
  const [allFinished, setAllFinished] = useState(false);
  // Reading mode groups questions by the PDF their first crop came from; Reorder keeps one flat list.
  const questionOrder = new Map(questions.map(([qid], index) => [qid, index]));
  const sourceOf = (qid: string) => {
    const revision = bank?.revisions[bank.questions[qid].revisionId];
    if (!revision) return undefined;
    for (const part of partOutline(revision, "")) {
      const cropId = revision.parts[part.id]?.cropIds[0];
      if (cropId) return revision.crops[cropId]?.sourcePdfFileId;
    }
    return undefined;
  };
  const sources = [...new Set(questions.map(([qid]) => sourceOf(qid) ?? ""))];
  const grouped = !reordering && !picking && sources.length > 1;
  const shownQuestions = grouped ? sources.flatMap(source => questions.filter(([qid]) => (sourceOf(qid) ?? "") === source)) : questions;
  const firstOfGroup = new Set(sources.map(source => shownQuestions.find(([qid]) => (sourceOf(qid) ?? "") === source)?.[0]).filter((id): id is string => !!id));
  useEffect(() => { setFailure(""); setReordering(false); setReorderFolds({}); setPicking(false); setSelectedQuestions(new Set()); setWorksheetTitle(""); setActiveAttemptState(openWorksheet(moduleId)); }, [moduleId]);
  const changeMode = (enabled: boolean) => {
    if (dragging || busy) return;
    const rows = section.current?.querySelectorAll<HTMLElement>("[data-bank-row]");
    const viewportTop = section.current?.closest("main")?.getBoundingClientRect().top ?? 0;
    const visible = rows && [...rows].find(row => row.getBoundingClientRect().bottom > viewportTop);
    anchor.current = visible ? { id: visible.dataset.bankRow!, top: visible.getBoundingClientRect().top } : null;
    if (enabled) {
      // Start compact on purpose, then let each branch be opened explicitly.
      // Keep reading folds separate so Done restores the original view.
      const compactFolds: Record<string, boolean> = {};
      for (const [qid, question] of questions) {
        for (const partId of Object.keys(bank!.revisions[question.revisionId].parts)) compactFolds[`${moduleId}:${qid}:${partId}`] = true;
      }
      setReorderFolds(compactFolds);
    }
    setReordering(enabled);
  };
  useLayoutEffect(() => {
    const previous = anchor.current;
    anchor.current = null;
    if (!previous) return;
    const row = [...(section.current?.querySelectorAll<HTMLElement>("[data-bank-row]") ?? [])].find(row => row.dataset.bankRow === previous.id);
    if (!row) return;
    let scroller = section.current?.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const offset = row.getBoundingClientRect().top - previous.top;
    if (scroller) scroller.scrollTop += offset;
    else window.scrollBy(0, offset);
  }, [reordering, reorderFolds]);
  useEffect(() => {
    if (!reordering || dragging || renaming !== null || busy) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && performance.now() > suppressClickUntil.current) changeMode(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  const reorderDisabled = picking || busy || !!dragging || renaming !== null;
  const worksheetDisabled = reordering || busy || !!dragging || renaming !== null;
  useEffect(() => {
    if (!nativeToolbar) return;
    postNativeEvent("questionBankState", { open: true, moduleId, controls: {
      visible: questions.length > 0 && !activeAttempt, reordering, reorderDisabled,
      newWorksheetVisible: !picking, worksheetDisabled,
    } });
    const reorder = () => { if (!activeAttempt && !reorderDisabled) changeMode(!reordering); };
    const worksheet = () => { if (!activeAttempt && !picking && !worksheetDisabled) { setPicking(true); setSelectedQuestions(new Set()); } };
    window.addEventListener("bank-reorder", reorder);
    window.addEventListener("bank-new-worksheet", worksheet);
    return () => {
      window.removeEventListener("bank-reorder", reorder);
      window.removeEventListener("bank-new-worksheet", worksheet);
    };
  }, [nativeToolbar, moduleId, questions.length, activeAttempt, reordering, reorderDisabled, worksheetDisabled, picking]);
  const run = async (args: BankEdit) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setFailure("");
    // Keep the destination order on screen until the edit receipt replaces it.
    if (bank && (args.kind === "moveQuestion" || args.kind === "movePart")) {
      const optimistic = structuredClone(bank);
      // Freeze the labels from the old order before moving any rows.
      Object.entries(optimistic.questions).filter(([, question]) => !question.deleted)
        .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
        .forEach(([, question], index) => { if (!question.title.trim()) question.title = String(index + 1); });
      const revision = args.questionId && optimistic.revisions[optimistic.questions[args.questionId].revisionId];
      const entries: [string, { order: number }][] = args.kind === "moveQuestion"
        ? Object.entries(optimistic.questions).filter(([, question]) => !question.deleted)
        : Object.entries(revision ? revision.parts : {}).filter(([, part]) => part.parentId === (revision && args.partId ? revision.parts[args.partId].parentId : undefined));
      entries.sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
      const from = entries.findIndex(([id]) => id === (args.partId ?? args.questionId));
      if (from >= 0) { const [entry] = entries.splice(from, 1); entries.splice(args.index ?? 0, 0, entry); entries.forEach(([, item], index) => { item.order = index; }); }
      setPendingBank({ moduleId, bank: optimistic });
    }
    try {
      const receipt = await edit(args);
      if (reordering && (args.kind === "transferPart" || args.kind === "promotePart" || args.kind === "nestQuestion")) {
        // Fresh cross-question IDs start folded too; leave all existing branches alone.
        const previousIds = new Set(Object.values(bank?.revisions ?? {}).flatMap(revision => Object.keys(revision.parts)));
        const addedFolds: Record<string, boolean> = {};
        for (const [qid, question] of Object.entries(receipt.bank.questions)) {
          for (const id of Object.keys(receipt.bank.revisions[question.revisionId].parts)) {
            if (!previousIds.has(id)) addedFolds[`${moduleId}:${qid}:${id}`] = true;
          }
        }
        setReorderFolds(previous => ({ ...previous, ...addedFolds }));
      }
      if (["moveQuestion", "movePart", "reparentPart", "transferPart", "promotePart", "nestQuestion"].includes(args.kind)) setPendingBank({ moduleId, bank: receipt.bank, received: true });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      await refetch();
      setPendingBank(null);
    } finally { saving.current = false; setBusy(false); }
  };
  const startWorksheet = async () => {
    if (busy) return;
    const questionIds = questions.filter(([id]) => selectedQuestions.has(id)).map(([id]) => id);
    if (!questionIds.length) return;
    setBusy(true); setFailure("");
    try {
      const id = await createWorksheet(worksheetTitle.trim() || "Worksheet", questionIds);
      setPendingBank(null);
      setPicking(false); setSelectedQuestions(new Set()); setWorksheetTitle("");
      setActiveAttempt({ moduleId, id });
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (activeAttempt?.moduleId === moduleId) {
    if (!savedBank) return <section className="space-y-3"><Button variant="ghost" onClick={() => setActiveAttempt(null)}>Back to questions</Button><p role={error ? "alert" : "status"}>{error ? `Could not load worksheet: ${error.message}` : "Loading worksheet…"}</p></section>;
    return <WorksheetAttempt key={`${moduleId}:${activeAttempt.id}`} moduleId={moduleId} attemptId={activeAttempt.id} bank={savedBank} onBack={() => setActiveAttempt(null)} />;
  }
  return <DndContext sensors={sensors} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }} collisionDetection={args => {
    const pointer = args.pointerCoordinates;
    const bounds = section.current?.getBoundingClientRect();
    const source = dragging ?? args.active.data.current as BankDrag;
    const clear = () => { dropBoundary.current = null; clearHover(); return []; };
    if (!pointer || !reordering || (bounds && (pointer.x < bounds.left || pointer.x > bounds.right || pointer.y < bounds.top || pointer.y > bounds.bottom))) return clear();
    // Headers express nesting intent. Whole-question block edges still reorder
    // the complete visible subtree, even when its last part is expanded.
    // Keep invalid rows in hit testing so a self/subtree hit cannot fall through.
    let nearest: { id: string; data: BankDrag; rect: { top: number; bottom: number; height: number }; distance: number } | null = null;
    for (const container of args.droppableContainers) {
      const data = container.data.current as BankDrag | undefined;
      const header = args.droppableRects.get(container.id);
      if (!data || !header || data.moduleId !== source.moduleId) continue;
      let bottom = header.bottom;
      if (!source.partId && !data.partId) {
        const end = args.droppableRects.get(data.endId) ?? header;
        const previous = dropBoundary.current;
        // Keep a generous outer edge target after opening children; only the
        // actual header's middle can nest into the question itself.
        const afterBand = previous?.id === String(container.id) && previous.edge === "after" ? 12 : 8;
        if (pointer.y >= end.bottom - afterBand) bottom = end.bottom;
      }
      const rect = { top: header.top, bottom, height: bottom - header.top };
      const distance = Math.max(rect.top - pointer.y, pointer.y - rect.bottom, 0);
      if (!nearest || distance < nearest.distance) nearest = { id: String(container.id), data, rect, distance };
    }
    if (!nearest || nearest.distance > 16) return clear();
    let { id, data } = nearest;
    const { rect } = nearest;
    if (source.questionId === data.questionId && source.subtreeIds.includes(data.rowPartId)) return clear();
    const ratio = (pointer.y - rect.top) / Math.max(rect.height, 1);
    const previous = dropBoundary.current?.id === id ? dropBoundary.current.edge : null;
    // A small dead band prevents a jitter at the middle/edge thresholds.
    let edge: DropEdge = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
    if (previous === "inside" && ratio >= 0.19 && ratio <= 0.81) edge = "inside";
    if (previous === "before" && ratio < 0.31) edge = "before";
    if (previous === "after" && ratio > 0.69) edge = "after";
    let markerY: number | undefined;
    let between: string | undefined;
    if (edge !== "inside") {
      const siblings = args.droppableContainers.flatMap(container => {
        const sibling = container.data.current as BankDrag | undefined;
        const header = args.droppableRects.get(container.id);
        if (!sibling || !header || sibling.moduleId !== source.moduleId || sibling.group !== data.group) return [];
        const end = args.droppableRects.get(sibling.endId) ?? header;
        return [{ id: String(container.id), data: sibling, top: header.top, bottom: end.bottom }];
      }).sort((a, b) => a.data.index - b.data.index);
      const position = siblings.findIndex(sibling => sibling.id === id);
      const boundary = position + (edge === "after" ? 1 : 0);
      const left = siblings[boundary - 1];
      const right = siblings[boundary];
      if (position >= 0 && right) {
        // "After A" and "before B" are one canonical boundary: before B.
        id = right.id;
        data = right.data;
        edge = "before";
        markerY = left ? (left.bottom + right.top) / 2 - 1 : right.top - 3;
        if (left) between = `Between ${left.data.label} and ${right.data.label}`;
      } else if (position >= 0 && left) {
        id = left.id;
        data = left.data;
        edge = "after";
        markerY = left.bottom + 2;
      }
    }
    const plan = dropPlan(source, data, edge);
    if (plan && between) plan.cue = `${plan.edit.kind === "promotePart" ? "New question · " : ""}${between}`;
    dropBoundary.current = { id, edge, plan };
    if (plan?.inside && data.folded && data.childCount > 0 && pointer.y >= rect.top && pointer.y <= rect.bottom) {
      if (hoverOpen.current?.id !== id) {
        clearHover();
        hoverOpen.current = { id, timer: setTimeout(() => {
          hoverOpen.current = null;
          if (dropBoundary.current?.id !== id || !dropBoundary.current.plan?.inside) return;
          const row = [...(section.current?.querySelectorAll<HTMLElement>("[data-bank-row]") ?? [])].find(row => row.dataset.bankRow === id);
          anchor.current = row ? { id, top: row.getBoundingClientRect().top } : null;
          setReorderFolds(previous => ({ ...previous, [id]: false }));
        }, 2000) };
      }
    } else clearHover();
    return [{ id, data: { edge, plan, markerY, value: nearest.distance } }];
  }} accessibility={{ screenReaderInstructions: { draggable: "Drag a question or part over the middle of another row to make it a part. Drag a question to a question edge to reorder; a part at a question edge becomes a new question. Hold inside a folded row to expand it. Use the context menu for keyboard reordering." } }}
    onDragStart={({ active }) => { clearHover(); dropBoundary.current = null; suppressClickUntil.current = Infinity; setDragging(structuredClone(active.data.current as BankDrag)); }}
    onDragCancel={() => { clearHover(); suppressClickUntil.current = performance.now() + 500; dropBoundary.current = null; setDragging(null); }}
    onDragEnd={({ over }) => {
      const boundary = dropBoundary.current;
      const plan = over && boundary?.id === String(over.id) ? boundary.plan : null;
      clearHover();
      suppressClickUntil.current = performance.now() + 500;
      setDragging(null);
      dropBoundary.current = null;
      if (!saving.current && plan) void run(plan.edit);
    }}>
  <section ref={section} aria-label="Question bank" className={cn(questionReadingWidth, "pb-16", reordering && "bank-reorder-outline")}
    onClickCapture={event => { if (performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }}
    onDoubleClickCapture={event => { if (performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }}>
    {questions.length > 0 && !nativeToolbar && <div className="mb-3 flex h-7 min-w-0 items-center justify-end">
      {reordering
        ? <Button size="sm" variant="ghost" aria-pressed disabled={picking || busy || !!dragging || renaming !== null} onClick={() => changeMode(false)}>Done</Button>
        : <ToolButton label="Reorder questions" disabled={picking || busy || !!dragging || renaming !== null} onClick={() => changeMode(true)}><ArrowUpDown /></ToolButton>}
      {!picking && <ToolButton label="New worksheet" disabled={reordering || busy || !!dragging || renaming !== null} onClick={() => { setPicking(true); setSelectedQuestions(new Set()); }}><FilePlus2 /></ToolButton>}
      <span className="sr-only" role="status">{busy ? "Saving…" : ""}</span>
    </div>}
    {picking && <div className="mb-5 space-y-3">
      <p className="text-sm text-muted-foreground">Worksheet · this module</p>
      <input aria-label="Worksheet title" placeholder="Worksheet title" maxLength={120} value={worksheetTitle} onChange={event => setWorksheetTitle(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelectedQuestions(new Set(questions.map(([id]) => id)))}>Select all</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPicking(false); setSelectedQuestions(new Set()); }}>Cancel</Button>
        <Button size="sm" disabled={busy || !questions.some(([id]) => selectedQuestions.has(id))} onClick={() => void startWorksheet()}>{busy ? "Starting…" : `Start worksheet (${questions.filter(([id]) => selectedQuestions.has(id)).length})`}</Button>
      </div>
    </div>}
    {!picking && [false, true].map(finished => {
      const all = Object.entries(savedBank?.attempts ?? {}).filter(([, attempt]) => !attempt.deleted && !!attempt.finished === finished).reverse();
      const expanded = finished ? allFinished : allWorksheets;
      const setExpanded = finished ? setAllFinished : setAllWorksheets;
      if (!all.length) return null;
      return <section key={String(finished)} aria-label={finished ? "Finished" : "Recent worksheets"} className="mb-6 space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">{finished ? "Finished" : "Recent worksheets"}</h3>
        {(expanded ? all : all.slice(0, 3)).map(([id, attempt]) => <div key={id} className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
          <div className="min-w-0"><p className="truncate text-sm font-medium">{attempt.title || "Worksheet"}</p><p className="text-xs text-muted-foreground">{attempt.questions.length} {attempt.questions.length === 1 ? "question" : "questions"}</p></div>
          <Button size="sm" variant="ghost" onClick={() => setActiveAttempt({ moduleId, id })}>{finished ? "Review" : "Resume"}<span className="sr-only"> {attempt.title || "worksheet"}</span></Button>
        </div>)}
        {all.length > 3 && <Button size="sm" variant="ghost" onClick={() => setExpanded(open => !open)}>{expanded ? "Show recent" : `All worksheets (${all.length})`}</Button>}
      </section>;
    })}
    {(failure || error) && <p role="alert" className="mb-4 text-sm text-destructive">{failure || error?.message}</p>}
    {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
    {!isLoading && !questions.length && <p className="text-sm text-muted-foreground">Open a PDF and choose <span className="text-foreground">Crop question</span> to add questions.</p>}
    <div className="space-y-2">{shownQuestions.map(([qid, question]) => {
      const index = questionOrder.get(qid) ?? 0;
      const revision = bank!.revisions[question.revisionId]; const outline = partOutline(revision, questionLabel(question.title, index + 1));
      const group = grouped ? sourceOf(qid) : undefined;
      const header = grouped && firstOfGroup.has(qid) ? <h3 className="bank-source-heading mt-6 mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground first:mt-0"><FileText size={14} />{group ? documents.find(d => d.id === group)?.name ?? "Deleted file" : "No source file"}</h3> : null;
      return <Fragment key={qid}>{header}<article aria-label={`Question ${index + 1}`} className={cn("group/question last:pb-0", !reordering && !visibleFolds[`${moduleId}:${qid}:${revision.rootPartId}`] && "pb-4")}>
        {outline.map((part, position) => {
          const ancestors: typeof outline = [];
          for (const preceding of outline.slice(0, position)) { ancestors[preceding.depth] = preceding; ancestors.length = preceding.depth + 1; }
          if (ancestors.slice(0, part.depth).some(parent => visibleFolds[`${moduleId}:${qid}:${parent.id}`])) return null;
          const key = `${moduleId}:${qid}:${part.id}`; const folded = !!visibleFolds[key];
          const descendants = outline.slice(position + 1); const end = descendants.findIndex(child => child.depth <= part.depth);
          const subtree = descendants.slice(0, end < 0 ? undefined : end); const parts = subtree.filter(child => child.depth === part.depth + 1).length;
          const visibleSubtree = subtree.filter((child, offset) => {
            if (folded) return false;
            const parents = [part];
            for (const preceding of subtree.slice(0, offset)) { parents[preceding.depth - part.depth] = preceding; parents.length = preceding.depth - part.depth + 1; }
            return !parents.slice(0, child.depth - part.depth).some(parent => visibleFolds[`${moduleId}:${qid}:${parent.id}`]);
          });
          const root = part.depth === 0; const current = target?.questionId === qid && target.partId === part.id;
          const parentId = revision.parts[part.id].parentId;
          const siblings = root ? [] : Object.entries(revision.parts).filter(([, p]) => p.parentId === parentId).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
          const place = siblings.findIndex(([id]) => id === part.id);
          const cropIds = revision.parts[part.id].cropIds; const foldable = subtree.length > 0 || (!reordering && cropIds.length > 0);
          const layout = questionReadingLayout(part.depth, folded, cropIds.length > 0, reordering);
          const draggedSubtree = dragging?.questionId === qid && (!dragging.partId || dragging.partId === part.id || ancestors.slice(0, part.depth).some(parent => parent.id === dragging.partId));
          const rowIndex = root ? index : place; const rowCount = root ? questions.length : siblings.length;
          const pin = { questionId: qid, expectedRevisionId: question.revisionId };
          const move = (to: number) => void run({ kind: root ? "moveQuestion" : "movePart", ...pin, partId: root ? undefined : part.id, index: to });
          const rowActions: RowAction[] = [
            { label: root ? "Rename question" : "Rename part", icon: <Pencil />, disabled: busy, run: () => setRenaming(key) },
            { label: "Move up", icon: <ArrowUp />, disabled: busy || rowIndex === 0, run: () => move(rowIndex - 1) },
            { label: "Move down", icon: <ArrowDown />, disabled: busy || rowIndex === rowCount - 1, run: () => move(rowIndex + 1) },
            { label: root ? "Delete question" : "Delete part", icon: <Trash2 />, disabled: busy, destructive: true,
              run: () => void run({ kind: root ? "deleteQuestion" : "deletePart", ...pin, partId: root ? undefined : part.id }) },
          ];
          return <div key={part.id} style={{ marginLeft: layout.marginLeft }} className={cn(layout.partClass, draggedSubtree && "opacity-40")}>
            <BankRow id={key} disabled={!reordering || busy || renaming !== null} data={{ moduleId, rowPartId: part.id, parentId, subtreeIds: [part.id, ...subtree.map(child => child.id)], folded, childCount: parts, nextChildLabel: nextPartLabel(revision, part.id), group: root ? `${moduleId}:questions` : `${qid}:${parentId}`, label: `Question ${part.label}`, index: rowIndex, ...pin, partId: root ? undefined : part.id, endId: `${moduleId}:${qid}:${visibleSubtree[visibleSubtree.length - 1]?.id ?? part.id}`, preview: [part, ...visibleSubtree].map(item => ({ label: item.depth === 0 ? `Question ${questionLabel(question.title, index + 1)}` : own(revision.parts[item.id].label), depth: item.depth - part.depth })) }} actions={rowActions}>
              {root && picking && <input type="checkbox" aria-label={`Select question ${questionLabel(question.title, index + 1)}`} checked={selectedQuestions.has(qid)} disabled={busy} className="mt-1.5 h-4 w-4 shrink-0 accent-[var(--primary)]" onChange={event => { const checked = event.target.checked; setSelectedQuestions(previous => { const next = new Set(previous); if (checked) next.add(qid); else next.delete(qid); return next; }); }} />}
              <span className="bank-disclosure flex h-7 w-4 shrink-0 items-center justify-center">{foldable && <button type="button" aria-label={`${folded ? "Expand" : "Fold"} ${part.label}`} title={reordering ? `${folded ? "Show" : "Hide"} ${parts} ${parts === 1 ? "part" : "parts"}` : undefined} aria-expanded={!folded} disabled={!!dragging} className="text-muted-foreground hover:text-foreground" onClick={() => toggle(key)}><ChevronRight size={14} className={folded ? "" : "rotate-90"} /></button>}</span>
              <EditableLabel editing={renaming === key} renameTitle={root ? "Rename question" : "Rename part"} value={root ? questionLabel(question.title, index + 1) : own(revision.parts[part.id].label)} onStart={() => { if (!busy && !dragging) setRenaming(key); }} onCancel={() => setRenaming(null)}
                onSave={text => { setRenaming(null); const trimmed = text.trim(); const pin = { questionId: qid, expectedRevisionId: question.revisionId };
                  if (root) { if (trimmed && trimmed !== questionLabel(question.title, index + 1)) void run({ kind: "renameQuestion", ...pin, title: trimmed }); }
                  else if (trimmed && trimmed !== own(revision.parts[part.id].label)) void run({ kind: "renamePart", ...pin, partId: part.id, label: trimmed }); }}
                aria-label={`Add next crops to ${part.label}`} aria-pressed={current} className={cn(layout.labelClass, current && "text-foreground")} onClick={() => setBankTarget({ moduleId, questionId: qid, partId: part.id })}>{root ? questionLabel(question.title, index + 1) : own(revision.parts[part.id].label)}</EditableLabel>
              {parts > 0 && (reordering || folded) && <button type="button" disabled={!!dragging} aria-label={`${folded ? "Show" : "Hide"} parts of ${part.label}`} aria-expanded={!folded} className="bank-part-count ml-2 flex h-7 shrink-0 items-center self-center rounded-sm text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => toggle(key)}>{parts} {parts === 1 ? "part" : "parts"}</button>}
            </BankRow>
            <div className={layout.contentClass}>
              {!folded && cropIds.map((cid, cropIndex) => {
                const crop = revision.crops[cid];
                const pin = { questionId: qid, partId: part.id, expectedRevisionId: question.revisionId, cropId: cid };
                return <BankCrop key={`${cid}:${crop.assetId}`} moduleId={moduleId} crop={crop} alt={`Question ${part.label}, crop ${cropIndex + 1}`} disabled={busy} onTrim={async replacement => {
                  setBusy(true);
                  try { await edit({ kind: "replaceCrop", ...pin, crop: replacement }); }
                  catch (error) { await refetch(); throw error; }
                  finally { setBusy(false); }
                }}>
                    <DropdownMenuItem aria-label={`Open ${documents.find(d => d.id === crop.sourcePdfFileId)?.name ?? "source PDF"}, page ${crop.pageIndex + 1}`} onClick={() => { requestPdfPage(crop.sourcePdfFileId, crop.pageIndex + 1); if (onOpenSource) onOpenSource(crop.sourcePdfFileId); else updatePdfPane(moduleId, { open: true, active: crop.sourcePdfFileId }); }}><FileText /><span className="min-w-0 truncate" title={documents.find(d => d.id === crop.sourcePdfFileId)?.name}>Open {documents.find(d => d.id === crop.sourcePdfFileId)?.name ?? "source PDF"}</span><span className="ml-auto shrink-0">page {crop.pageIndex + 1}</span></DropdownMenuItem>
                    {cropIds.length > 1 && <>
                      <DropdownMenuItem disabled={busy || cropIndex === 0} onClick={() => void run({ kind: "reorderCrop", ...pin, index: cropIndex - 1 })}><ArrowUp />Move up</DropdownMenuItem>
                      <DropdownMenuItem disabled={busy || cropIndex === cropIds.length - 1} onClick={() => void run({ kind: "reorderCrop", ...pin, index: cropIndex + 1 })}><ArrowDown />Move down</DropdownMenuItem>
                    </>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={busy} onClick={() => void run({ kind: "removeCrop", ...pin })}><Trash2 />Remove crop</DropdownMenuItem>
                </BankCrop>;
              })}
              {!folded && !cropIds.length && !root && <p className="py-1 text-sm text-muted-foreground">No crops yet</p>}
            </div>
          </div>;
        })}
      </article></Fragment>;
    })}</div>
  </section>
  {createPortal(<DragOverlay dropAnimation={null}>{dragging && <div className="bank-drag-preview w-fit max-w-72 rounded-md border border-border bg-popover px-3 py-2 text-sm font-semibold text-popover-foreground shadow-md" aria-hidden="true">{dragging.preview.slice(0, 4).map((part, index) => <div key={index} className="truncate leading-6" style={{ paddingLeft: part.depth * 16 }}>{part.label}</div>)}{dragging.preview.length > 4 && <div className="leading-6 font-normal text-muted-foreground">+{dragging.preview.length - 4} more parts</div>}</div>}</DragOverlay>, document.body)}
  </DndContext>;
}

