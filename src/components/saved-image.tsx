import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ResizableNodeView } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlignLeft, AlignCenter, AlignRight, Crop, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileType } from "@/lib/content";

type FilesContextValue = {
  files: ReadonlyMap<string, FileType>;
  saveImage: (file: File) => Promise<FileType>;
  readImage: (fileId: string) => Promise<Blob>;
};

export const FilesContext = createContext<FilesContextValue>({
  files: new Map(),
  saveImage: async () => { throw new Error("Image storage is unavailable"); },
  readImage: async () => { throw new Error("Image storage is unavailable"); },
});

type Crop = { x: number; y: number; width: number; height: number };

function CropDialog({ image, onCancel, onSave }: {
  image: HTMLImageElement;
  onCancel: () => void;
  onSave: (crop: Crop) => Promise<void>;
}) {
  const preview = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; crop: Crop; mode: "move" | "resize" } | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0.08, y: 0.08, width: 0.84, height: 0.84 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, mode: "move" | "resize") => {
    const bounds = preview.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, crop, mode };
  };

  const updateDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    const bounds = preview.current?.getBoundingClientRect();
    if (!current || !bounds || current.pointerId !== event.pointerId) return;
    const dx = (event.clientX - current.startX) / bounds.width;
    const dy = (event.clientY - current.startY) / bounds.height;
    if (current.mode === "move") {
      setCrop({ ...current.crop, x: Math.max(0, Math.min(1 - current.crop.width, current.crop.x + dx)), y: Math.max(0, Math.min(1 - current.crop.height, current.crop.y + dy)) });
    } else {
      setCrop({ ...current.crop, width: Math.max(0.12, Math.min(1 - current.crop.x, current.crop.width + dx)), height: Math.max(0.12, Math.min(1 - current.crop.y, current.crop.height + dy)) });
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try { await onSave(crop); } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the cropped image");
      setSaving(false);
    }
  };

  return (
    <div className="image-crop-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="image-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="image-crop-title">
        <h2 id="image-crop-title">Crop image</h2>
        <p>Drag the crop area to reposition it, or drag its lower corner to resize.</p>
        <div ref={preview} className="image-crop-preview" style={{ aspectRatio: `${image.naturalWidth} / ${image.naturalHeight}` }}>
          <img src={image.src} alt="Crop preview" draggable={false} />
          <div className="image-crop-selection" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => beginDrag(event, "move")} onPointerMove={updateDrag} onPointerUp={() => { drag.current = null; }}>
            <span className="image-crop-resize" aria-label="Resize crop area" onPointerDown={(event) => { event.stopPropagation(); beginDrag(event, "resize"); }} onPointerMove={updateDrag} onPointerUp={() => { drag.current = null; }} />
          </div>
        </div>
        {error && <p className="image-crop-error" role="alert">{error}</p>}
        <div className="image-crop-actions"><Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button><Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Apply crop"}</Button></div>
      </section>
    </div>
  );
}

function SavedImageView(props: NodeViewProps) {
  const { node, selected, editor, updateAttributes, deleteNode } = props;
  const { files, saveImage, readImage } = useContext(FilesContext);
  const file = files.get(node.attrs.fileId);
  const src = file ? convertFileSrc(file.path) : node.attrs.src;
  const host = useRef<HTMLDivElement>(null);
  // The host shrinks with the image; its containing block defines room to grow.
  const getAvailableWidth = () =>
    host.current?.closest<HTMLElement>(".note-image-block")?.parentElement?.clientWidth ?? 0;
  const image = useRef<HTMLImageElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);

  useEffect(() => {
    if (!host.current || !src) return;
    setFailed(false);
    const img = document.createElement("img");
    image.current = img;
    img.className = "note-image";
    img.draggable = false;
    img.src = src;
    img.alt = latest.current.node.attrs.alt ?? "";
    img.title = latest.current.node.attrs.title ?? "";
    img.onerror = () => setFailed(true);
    img.onload = () => setFailed(false);
    const view = new ResizableNodeView({
      element: img,
      editor,
      node: latest.current.node,
      getPos: () => latest.current.getPos(),
      onUpdate: () => true,
      onResize: (width) => {
        img.style.width = `${width}px`;
        img.style.height = "auto";
      },
      onCommit: (width, height) => {
        if (editor.isDestroyed || latest.current.getPos() === undefined) return;
        latest.current.updateAttributes({ width: Math.round(width), height: Math.round(height) });
      },
      options: {
        directions: ["bottom-left", "bottom-right", "top-left", "top-right"],
        min: { width: 48, height: 48 },
        max: {
          // Read at drag time: the sidebar/window can change the available width
          // after this node view mounts (including initially hidden sections).
          get width() {
            return getAvailableWidth() || undefined;
          },
        },
        preserveAspectRatio: true,
      },
    });
    // Keep proportions when a saved image is wider than the current editor.
    img.style.height = "auto";
    host.current.appendChild(view.dom);
    return () => {
      img.onload = null;
      img.onerror = null;
      view.destroy();
      image.current = null;
    };
  }, [src, editor]);

  useEffect(() => {
    if (!image.current) return;
    image.current.alt = node.attrs.alt ?? "";
    image.current.title = node.attrs.title ?? "";
    image.current.style.width = node.attrs.width ? `${node.attrs.width}px` : "";
    image.current.style.height = "auto";
  }, [src, node.attrs.alt, node.attrs.title, node.attrs.width, node.attrs.height]);

  const resizeTo = (fraction: number) => {
    const img = image.current;
    if (!img?.naturalWidth || !host.current) return;
    const width = Math.round(getAvailableWidth() * fraction);
    updateAttributes({ width, height: Math.round(width * img.naturalHeight / img.naturalWidth) });
  };

  const selectImage = () => {
    if (!editor.isEditable) return;
    const position = latest.current.getPos();
    if (position !== undefined && position >= 0 && position < editor.state.doc.content.size) {
      editor.commands.setNodeSelection(position);
    }
  };

  const applyCrop = async (crop: Crop) => {
    const fileId = node.attrs.fileId as string | null;
    if (!fileId) throw new Error("This image cannot be read for cropping");
    const original = await readImage(fileId);
    const sourceUrl = URL.createObjectURL(original);
    try {
      const source = document.createElement("img");
      await new Promise<void>((resolve, reject) => {
        source.onload = () => resolve();
        source.onerror = () => reject(new Error("Could not open the image for cropping"));
        source.src = sourceUrl;
      });
      if (!source.naturalWidth || !source.naturalHeight) throw new Error("Image is not ready to crop");
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(crop.width * source.naturalWidth));
      canvas.height = Math.max(1, Math.round(crop.height * source.naturalHeight));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare the cropped image");
      context.drawImage(source, Math.round(crop.x * source.naturalWidth), Math.round(crop.y * source.naturalHeight), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create the cropped image")), "image/png"));
      const saved = await saveImage(new File([blob], `${node.attrs.alt || "image"}-cropped.png`, { type: "image/png" }));
      updateAttributes({ fileId: saved.id, src: null, width: null, height: null });
      setCropOpen(false);
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  };

  return (
    <NodeViewWrapper contentEditable={false} className="note-image-block" data-selected={selected} data-align={node.attrs.alignment}>
      <div ref={host} className="note-image-host" data-drag-handle onClick={selectImage} />
      {(!src || failed) && <span className="text-sm text-muted-foreground">Image unavailable</span>}
      {selected && editor.isEditable && (
        <div className="note-image-controls" aria-label="Image controls" contentEditable={false}>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Image size and alignment">
            {[25, 50, 75].map((size) => (
              <Button key={size} size="xs" variant="ghost" onClick={() => resizeTo(size / 100)} disabled={!src || failed} aria-label={`Set image to ${size}% of editor width`}>{size}%</Button>
            ))}
            <Button size="xs" variant="ghost" onClick={() => updateAttributes({ width: null, height: null })}>Original size</Button>
            <Button size="icon-xs" variant="ghost" aria-label="Crop image" title="Crop image" onClick={() => setCropOpen(true)} disabled={!src || failed || !node.attrs.fileId}><Crop /></Button>
            {([ ["left", AlignLeft], ["center", AlignCenter], ["right", AlignRight] ] as const).map(([alignment, Icon]) => (
              <Button key={alignment} size="icon-xs" variant="ghost" aria-label={`Align image ${alignment}`} title={`Align ${alignment}`} aria-pressed={node.attrs.alignment === alignment} onClick={() => updateAttributes({ alignment })}><Icon /></Button>
            ))}
            <Button size="icon-xs" variant="ghost" aria-label="Remove image" title="Remove image" onClick={deleteNode}><Trash2 /></Button>
          </div>
          <details>
            <summary>Image description</summary>
            <div className="grid gap-2 pt-2">
              <label>Alt text<input key={`alt-${node.attrs.alt}`} defaultValue={node.attrs.alt ?? ""} placeholder="Describe the image" onBlur={(event) => { if (event.target.value !== (node.attrs.alt ?? "")) updateAttributes({ alt: event.target.value }); }} /></label>
              <label>Title<input key={`title-${node.attrs.title}`} defaultValue={node.attrs.title ?? ""} placeholder="Shown when hovering over the image" onBlur={(event) => { if (event.target.value !== (node.attrs.title ?? "")) updateAttributes({ title: event.target.value }); }} /></label>
            </div>
          </details>
        </div>
      )}
      {cropOpen && image.current && <CropDialog image={image.current} onCancel={() => setCropOpen(false)} onSave={applyCrop} />}
    </NodeViewWrapper>
  );
}

export const SavedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: { default: null, rendered: false },
      alignment: {
        default: "left",
        parseHTML: (element) => element.getAttribute("data-align") || "left",
        renderHTML: (attributes) => ({
          "data-align": attributes.alignment,
          style: `display: block; margin-left: ${attributes.alignment === "left" ? "0" : "auto"}; margin-right: ${attributes.alignment === "right" ? "0" : "auto"}`,
        }),
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(SavedImageView);
  },
});
