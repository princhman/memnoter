import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, FileImage, FileText, PanelRight, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { call, isNativeHost } from "@/lib/backend";
import { registerCommand } from "@/lib/commands";
import type { GetContentResponse } from "@/lib/content";
import type { DocumentRecord } from "@/lib/documents";
import { useModules } from "@/lib/modules";
import { documentName } from "@/lib/pdf-state";
import { useSyncedImageUrl } from "@/lib/synced-image";
import { useDocuments } from "@/lib/use-documents";
import { ImagePreview } from "./image-preview";
import { PdfViewer } from "./pdf-viewer";
import Tiptap from "./Tiptap";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { ToolButton } from "./ui/tool-button";

type Target =
  | { kind: "note"; id: string; title: string }
  | { kind: "pdf"; doc: DocumentRecord }
  | { kind: "image"; id: string; title: string };

function ImageTile({ id, title, onClick }: { id: string; title: string; onClick: () => void }) {
  const image = useSyncedImageUrl("worksheet-reference-image", id);
  return <Button variant="ghost" className="h-auto min-h-16 flex-col gap-1 p-2" onClick={onClick}>
    {image.data ? <img src={image.data} alt="" className="h-16 w-full object-contain" /> : <FileImage />}
    {title}
  </Button>;
}

function BesidePicker({ onChoose, onClose }: { onChoose: (target: Target) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<{ id: string; name: string } | null>(null);
  const { data: modules = [], error: notesError } = useModules();
  const { data: documents = [], error: filesError } = useDocuments();
  const images = useQuery({
    queryKey: ["worksheet-reference-images", source?.id],
    enabled: source !== null,
    queryFn: async () => {
      if (!source) return [];
      const content = await call<GetContentResponse>("get_content", { moduleId: source.id });
      return content.files.filter(file => file.file_type.startsWith("image/"));
    },
  });
  const query = search.trim().toLowerCase();
  const notes = modules.filter(module => (module.name || "Untitled note").toLowerCase().includes(query));
  const pdfs = documents.filter(doc => `${documentName(doc.name)} ${doc.moduleName}`.toLowerCase().includes(query));

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="gap-2 sm:max-w-md">
      <DialogTitle className="pr-8">{source ? `Images in ${source.name}` : "Open beside"}</DialogTitle>
      {source ? <>
        <Button variant="ghost" className="w-fit" onClick={() => setSource(null)}><ChevronLeft /> Back</Button>
        {images.error ? <p role="alert">{images.error.message}</p> : images.data?.length === 0 ? <p className="p-2 text-muted-foreground">No images in this note</p> :
          <div className="grid max-h-[50dvh] grid-cols-3 gap-1 overflow-auto">
            {images.data?.map((image, index) => {
              const title = `Image ${index + 1}`;
              return <ImageTile key={image.id} id={image.id} title={title} onClick={() => onChoose({ kind: "image", id: image.id, title })} />;
            })}
          </div>}
      </> : <>
        <Input aria-label="Search notes and files" placeholder="Search notes and files" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="max-h-[50dvh] overflow-auto overscroll-contain">
          {(notesError || filesError) && <p role="alert" className="p-2">{(notesError ?? filesError)?.message}</p>}
          {notes.map(module => {
            const title = module.name || "Untitled note";
            return <div key={module.id} className="flex items-center gap-1">
              <Button variant="ghost" className="min-h-11 min-w-0 flex-1 justify-start" onClick={() => onChoose({ kind: "note", id: module.id, title })}><FileText /><span className="truncate">{title}</span></Button>
              <ToolButton label={`Browse images in ${title}`} className="size-11 shrink-0" onClick={() => setSource({ id: module.id, name: title })}><FileImage /></ToolButton>
            </div>;
          })}
          {pdfs.map(doc => <Button key={doc.id} variant="ghost" className="min-h-11 w-full justify-start" onClick={() => onChoose({ kind: "pdf", doc })}>
            <FileText /><span className="truncate">{documentName(doc.name)}</span><span className="ml-auto truncate text-xs text-muted-foreground">{doc.moduleName}</span>
          </Button>)}
          {!notes.length && !pdfs.length && !(notesError || filesError) && <p className="p-2 text-muted-foreground">No matching notes or files</p>}
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}

function BesideImage({ id, title }: { id: string; title: string }) {
  const image = useSyncedImageUrl("worksheet-reference-image", id);
  if (image.isError) return <p role="alert" className="p-4">Image unavailable on this device</p>;
  return <ImagePreview src={image.data} alt={title} />;
}

const clampShare = (share: number) => Math.min(65, Math.max(35, share));

export function WorksheetBeside({ toolbar, children }: { toolbar: HTMLElement | null; children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [picker, setPicker] = useState(false);
  const [share, setShare] = useState(45);
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const scroll = useRef<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = target !== null;

  useEffect(() => {
    if (isNativeHost()) {
      const openBeside = () => setPicker(true);
      window.addEventListener("worksheet-open-beside", openBeside);
      return () => window.removeEventListener("worksheet-open-beside", openBeside);
    }
    return registerCommand({ id: "worksheet.open-beside", title: "Open beside", keywords: ["worksheet", "note", "file", "pdf", "image"], run: () => setPicker(true) });
  }, []);

  const outerScroll = () => root.current?.parentElement?.closest<HTMLElement>(".app-scroll-container");
  useLayoutEffect(() => {
    const scroller = open ? main.current : outerScroll();
    if (scroll.current !== null && scroller) scroller.scrollTop = scroll.current;
    scroll.current = null;
  }, [open]);

  useLayoutEffect(() => {
    const element = divider.current;
    if (!open || !element) return;
    const updateOrientation = () => {
      element.setAttribute("aria-orientation", element.offsetWidth > element.offsetHeight ? "horizontal" : "vertical");
    };
    updateOrientation();
    const observer = new ResizeObserver(updateOrientation);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const openTarget = (next: Target) => {
    if (!open) scroll.current = outerScroll()?.scrollTop ?? 0;
    setTarget(next);
    setPicker(false);
  };
  const close = () => {
    scroll.current = main.current?.scrollTop ?? 0;
    setTarget(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const openButton = <ToolButton ref={trigger} label="Open beside" onClick={() => setPicker(true)} className="worksheet-beside-open shrink-0 text-foreground"><PanelRight /></ToolButton>;
  const closeButton = <ToolButton label="Close side pane" onClick={close} className="worksheet-beside-close shrink-0 text-foreground"><X /></ToolButton>;
  const resize = useRef<{ id: number; width: number; height: number; x: number; y: number; stacked: boolean; share: number } | null>(null);
  const title = target?.kind === "pdf" ? documentName(target.doc.name) : target?.title;

  return <div ref={root} className="worksheet-beside" data-split={open || undefined} style={{ "--beside-share": `${share}%` } as CSSProperties}>
    {toolbar && createPortal(openButton, toolbar)}
    <div ref={main} className={open ? "worksheet-beside-main app-scroll-container" : undefined}>
      {!toolbar && <div className="worksheet-beside-fallback mx-auto flex max-w-3xl justify-end">{openButton}</div>}
      {children}
    </div>
    {target && <>
      <div ref={divider} role="separator" tabIndex={0} aria-label="Resize side pane" aria-valuenow={share} aria-valuemin={35} aria-valuemax={65} className="worksheet-beside-divider"
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          setShare(value => clampShare(value + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? 5 : -5)));
        }}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0 || !root.current) return;
          event.preventDefault();
          const { width, height } = root.current.getBoundingClientRect();
          const divider = event.currentTarget.getBoundingClientRect();
          event.currentTarget.setPointerCapture(event.pointerId);
          resize.current = { id: event.pointerId, width, height, x: event.clientX, y: event.clientY, stacked: divider.width > divider.height, share };
        }}
        onPointerMove={event => {
          const drag = resize.current;
          if (!drag || drag.id !== event.pointerId) return;
          const delta = drag.stacked ? (drag.y - event.clientY) / drag.height : (drag.x - event.clientX) / drag.width;
          setShare(clampShare(drag.share + 100 * delta));
        }}
        onLostPointerCapture={() => { resize.current = null; }}
      />
      <aside aria-label="Worksheet side pane" className="worksheet-beside-content">
        <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 px-2">
          <span className="min-w-0 truncate pl-1 text-sm font-medium" title={title}>{title}</span>{closeButton}
        </div>
        {target.kind === "pdf" ? <div className="min-h-0 flex-1">
          <ActiveEditorProvider><PdfViewer key={target.doc.id} doc={target.doc} worksheetReference /></ActiveEditorProvider>
        </div> : target.kind === "note" ? <div className="app-scroll-container min-h-0 flex-1 overflow-auto overscroll-contain" aria-label={title}>
          <ActiveEditorProvider><Tiptap key={target.id} moduleId={target.id} beside /></ActiveEditorProvider>
        </div> : <div className="min-h-0 flex-1"><BesideImage key={target.id} id={target.id} title={target.title} /></div>}
      </aside>
    </>}
    {picker && <BesidePicker onChoose={openTarget} onClose={() => setPicker(false)} />}
  </div>;
}
