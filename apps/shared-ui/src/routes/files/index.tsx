import { useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { documentsKey, useDocuments } from "@/lib/use-documents";
import { moveDocument, type DocumentRecord } from "@/lib/documents";
import { documentName } from "@/lib/pdf-state";
import { writeOperation } from "@/lib/write-lifecycle";
import { DocumentActions } from "@/components/document-actions";
import { dropPdfs, pickPdfs } from "@/components/add-pdf";
import { isTauri } from "@/lib/backend";

export const Route = createFileRoute("/files/")({
  validateSearch: (search: Record<string, unknown>): { module?: string } => typeof search.module === "string" ? { module: search.module } : {},
  component: Files,
});

const rowClass = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm";

function FileLabel({ doc, showModule }: { doc: DocumentRecord; showModule: boolean }) {
  return <>
    <FileText className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate">{documentName(doc.name)}</span>
    {showModule && <span className="max-w-[30%] truncate text-xs text-muted-foreground">{doc.moduleName}</span>}
    <span className="shrink-0 text-xs text-muted-foreground">{!doc.available ? "Downloading" : doc.pageCount === null ? "PDF" : `${doc.pageCount} pages`}</span>
  </>;
}

function FileDropTarget({ id, after }: { id: string; after: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${id}:${after}`, data: { id, after } });
  return <div ref={setNodeRef} aria-hidden className={`pointer-events-none absolute inset-x-0 h-1/2 ${after ? "bottom-0" : "top-0"}`}>
    {isOver && <div data-file-drop-indicator className={`absolute inset-x-2 z-[1000] h-0.5 rounded-full bg-primary ${after ? "-bottom-px" : "-top-px"}`} />}
  </div>;
}

function receivePdfs(event: DragEvent, moduleId?: string) {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  event.stopPropagation();
  dropPdfs(Array.from(event.dataTransfer.files), moduleId);
}

function FileRow({ doc, showModule, disabled }: { doc: DocumentRecord; showModule: boolean; disabled: boolean }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: doc.id, disabled });
  return <li ref={setNodeRef} className={`relative ${isDragging ? "opacity-40" : ""}`} onDrop={event => receivePdfs(event, doc.moduleId)}>
    <DocumentActions doc={doc}>
      <Link to="/files/$documentId" params={{ documentId: doc.id }} draggable={false}
        onPointerDown={event => listeners?.onPointerDown?.(event)}
        className={`${rowClass} hover:bg-accent focus-visible:bg-accent focus-visible:outline-none`}>
        <FileLabel doc={doc} showModule={showModule} />
      </Link>
    </DocumentActions>
    <FileDropTarget id={doc.id} after={false} />
    <FileDropTarget id={doc.id} after />
  </li>;
}

function Files() {
  const { module: moduleId } = Route.useSearch();
  const { data: allDocs = [], error } = useDocuments();
  const docs = moduleId ? allDocs.filter(doc => doc.moduleId === moduleId) : allDocs;
  const client = useQueryClient();
  const [draggedId, setDraggedId] = useState<string>();
  const dragged = docs.find(doc => doc.id === draggedId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const mutation = useMutation({
    mutationFn: (move: Parameters<typeof moveDocument>[0]) => writeOperation(() => moveDocument(move)),
    onSettled: () => client.invalidateQueries({ queryKey: documentsKey }),
  });
  return <div className="min-h-full" onDragOver={event => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }} onDrop={event => receivePdfs(event, moduleId)}>
    <div className="mx-auto grid w-full max-w-md grid-cols-1 gap-6 px-4 py-8">
      {(error || mutation.error) && <p role="alert" className="text-center text-sm text-destructive">{(error ?? mutation.error)?.message}</p>}
      {!docs.length && <p className="text-center text-sm text-muted-foreground">Drop PDFs here{isTauri() && <>, or <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => pickPdfs(moduleId)}>choose files</button></>}.</p>}
      <DndContext sensors={sensors}
        collisionDetection={args => pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter(container => container.data.current?.id !== args.active.id) })}
        onDragStart={({ active }) => { if (typeof active.id === "string") setDraggedId(active.id); }}
        onDragCancel={() => setDraggedId(undefined)}
        onDragEnd={({ active, over }) => {
          setDraggedId(undefined);
          const id = active.id;
          const target = over?.data.current;
          if (typeof id !== "string" || typeof target?.id !== "string" || typeof target.after !== "boolean" || mutation.isPending) return;
          const { id: targetId, after } = target;
          const remaining = allDocs.filter(doc => doc.id !== id);
          const targetIndex = remaining.findIndex(doc => doc.id === targetId);
          const moved = allDocs.find(doc => doc.id === id);
          const sourceIndex = allDocs.findIndex(doc => doc.id === id);
          const insertAt = targetIndex + Number(after);
          if (!moved || targetIndex < 0 || sourceIndex === insertAt) return;
          remaining.splice(insertAt, 0, moved);
          void client.cancelQueries({ queryKey: documentsKey });
          client.setQueryData(documentsKey, remaining);
          mutation.mutate({ id, targetId, after }, { onError: () => {
            client.setQueryData(documentsKey, allDocs);
          } });
        }}>
        <ul aria-label="Files" className="grid grid-cols-1">
          {docs.map(doc => <FileRow key={doc.id} doc={doc} showModule={!moduleId} disabled={mutation.isPending} />)}
        </ul>
        {createPortal(<DragOverlay dropAnimation={null}>{dragged && <div inert aria-hidden className={`${rowClass} floating-surface cursor-grabbing`}>
          <FileLabel doc={dragged} showModule={!moduleId} />
        </div>}</DragOverlay>, document.body)}
      </DndContext>
    </div>
  </div>;
}
