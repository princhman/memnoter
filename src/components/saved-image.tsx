import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { mergeAttributes, ResizableNodeView } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { NodeType } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import Image from "@tiptap/extension-image";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlignLeft, AlignCenter, AlignRight, BetweenHorizontalStart, Captions, ChevronDown, Contrast, Crop, TextCursorInput, Trash2, WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileType } from "@/lib/content";
import { adaptedUrl, cachedAdaptedUrl } from "@/lib/image-adapt";
import { useDarkTheme } from "@/hooks/use-dark-theme";

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
type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const CROP_HANDLES: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_CROP = 0.05;

function resizeCrop(crop: Crop, handle: CropHandle, dx: number, dy: number): Crop {
  let left = crop.x, top = crop.y, right = crop.x + crop.width, bottom = crop.y + crop.height;
  if (handle.includes("w")) left = Math.max(0, Math.min(right - MIN_CROP, left + dx));
  if (handle.includes("e")) right = Math.min(1, Math.max(left + MIN_CROP, right + dx));
  if (handle.includes("n")) top = Math.max(0, Math.min(bottom - MIN_CROP, top + dy));
  if (handle.includes("s")) bottom = Math.min(1, Math.max(top + MIN_CROP, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function CropDialog({ image, onCancel, onSave }: {
  image: HTMLImageElement;
  onCancel: () => void;
  onSave: (crop: Crop) => Promise<void>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; crop: Crop; mode: "move" | CropHandle } | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, width: 1, height: 1 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, mode: "move" | CropHandle) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, crop, mode };
  };

  const updateDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    const bounds = frame.current?.getBoundingClientRect();
    if (!current || !bounds || current.pointerId !== event.pointerId) return;
    const dx = (event.clientX - current.startX) / bounds.width;
    const dy = (event.clientY - current.startY) / bounds.height;
    if (current.mode === "move") {
      setCrop({ ...current.crop, x: Math.max(0, Math.min(1 - current.crop.width, current.crop.x + dx)), y: Math.max(0, Math.min(1 - current.crop.height, current.crop.y + dy)) });
    } else {
      setCrop(resizeCrop(current.crop, current.mode, dx, dy));
    }
  };

  const endDrag = () => { drag.current = null; };

  const save = async () => {
    setSaving(true);
    setError("");
    try { await onSave(crop); } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the cropped image");
      setSaving(false);
    }
  };

  const area = { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` };
  const uncropped = crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;

  return (
    <div className="image-crop-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="image-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="image-crop-title">
        <h2 id="image-crop-title">Crop image</h2>
        <p>Drag any edge or corner to crop, or drag inside the area to reposition it.</p>
        <div className="image-crop-preview">
          <div ref={frame} className="image-crop-frame">
            <img src={image.src} alt="Crop preview" draggable={false} />
            <div className="image-crop-shade-clip"><div className="image-crop-shade" style={area} /></div>
            <div className="image-crop-selection" style={area} onPointerDown={(event) => beginDrag(event, "move")} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
              {CROP_HANDLES.map((handle) => (
                <span key={handle} className={`image-crop-handle image-crop-handle-${handle}`} aria-label={`Resize crop area (${handle})`} onPointerDown={(event) => beginDrag(event, handle)} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
              ))}
            </div>
          </div>
        </div>
        {error && <p className="image-crop-error" role="alert">{error}</p>}
        <div className="image-crop-actions"><Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button><Button onClick={() => void save()} disabled={saving || uncropped}>{saving ? "Saving…" : "Apply crop"}</Button></div>
      </section>
    </div>
  );
}

function SavedImageView(props: NodeViewProps) {
  const { node, selected, editor, updateAttributes, deleteNode } = props;
  const { files, saveImage, readImage } = useContext(FilesContext);
  const file = files.get(node.attrs.fileId);
  const src = file ? convertFileSrc(file.path) : node.attrs.src;
  const isInline = node.type.isInline;
  const host = useRef<HTMLElement>(null);
  // The host shrinks with the image; its containing block defines room to grow.
  const getAvailableWidth = () =>
    host.current?.closest<HTMLElement>(".note-image-block")?.parentElement?.clientWidth ?? 0;
  const image = useRef<HTMLImageElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [describing, setDescribing] = useState(false);
  const dark = useDarkTheme();
  const adaptive = Boolean(node.attrs.adaptive);

  useEffect(() => {
    if (!host.current || !src) return;
    setFailed(false);
    const img = document.createElement("img");
    image.current = img;
    img.className = "note-image";
    img.draggable = false;
    img.loading = "lazy";
    img.decoding = "async";
    const { width, height } = latest.current.node.attrs;
    if (width > 0 && height > 0) {
      img.width = width;
      img.height = height;
      img.style.aspectRatio = `${width} / ${height}`;
    }
    if (latest.current.node.attrs.adaptive) {
      // Start on the recolored copy when one is ready; otherwise stay hidden
      // until it is, rather than flashing the original's background.
      const cached = cachedAdaptedUrl(latest.current.node.attrs.fileId ?? src, dark);
      if (cached) img.src = cached;
      else {
        img.src = src;
        img.style.opacity = "0";
      }
    } else img.src = src;
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

  // Recolored on the fly rather than saved, so it follows theme changes.
  useEffect(() => {
    const img = image.current;
    if (!img || !src) return;
    const fileId = node.attrs.fileId as string | null;
    const key = fileId ?? src;
    if (img.src === (adaptive ? cachedAdaptedUrl(key, dark) : src)) return;
    let cancelled = false;
    let stopWaiting: (() => void) | undefined;
    void (async () => {
      // Recoloring is costly, so images far off screen wait until they come close.
      if (adaptive) {
        await new Promise<void>((resolve) => {
          const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            resolve();
          }, { rootMargin: "1000px 0px" });
          observer.observe(img);
          stopWaiting = () => observer.disconnect();
        });
      }
      if (cancelled) return;
      const next = adaptive
        ? await adaptedUrl(key, dark, async () => fileId ? readImage(fileId) : (await fetch(src)).blob())
        : src;
      // Decode first so the swap never shows an empty frame.
      const probe = document.createElement("img");
      probe.src = next;
      await probe.decode();
      if (!cancelled) swapImage(img, next);
    })().catch((error) => {
      console.error("Failed to adapt image:", error);
      if (!cancelled) swapImage(img, src);
    });
    return () => {
      cancelled = true;
      stopWaiting?.();
    };
  }, [src, adaptive, dark, node.attrs.fileId, readImage]);

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

  const layout: ImageLayout = isInline ? "inline" : node.attrs.wrap ? "wrap" : "break";

  // Mirrors Google Docs' image layouts. A node type is either inline or block,
  // so moving into or out of a line of text replaces the node.
  const setLayout = (target: ImageLayout) => {
    if (target === layout) return;
    const wrap = target === "wrap";
    // Wrapped text flows around one side, so a centred image has no wrap side.
    const alignment = wrap && node.attrs.alignment === "center" ? "left" : node.attrs.alignment;
    if (!isInline && target !== "inline") {
      updateAttributes({ wrap, alignment });
      return;
    }
    const position = latest.current.getPos();
    if (position === undefined) return;
    const { state, schema } = editor;
    const { fileId, src, alt, title, width, height, adaptive } = node.attrs;
    const tr = state.tr;
    let selectAt: number;
    if (isInline) {
      const image = schema.nodes.image.create({ fileId, src, alt, title, width, height, adaptive, alignment, wrap });
      tr.delete(position, position + 1);
      const $at = tr.doc.resolve(position);
      if ($at.parent.content.size === 0) {
        // The image was alone in its line: take that line's place.
        selectAt = $at.before();
        tr.replaceWith(selectAt, $at.after(), image);
      } else {
        if ($at.parentOffset === 0) selectAt = $at.before();
        else if ($at.parentOffset === $at.parent.content.size) selectAt = $at.after();
        else {
          tr.split(position);
          selectAt = position + 1;
        }
        tr.insert(selectAt, image);
      }
    } else {
      const image = schema.nodes.inlineImage.create({ fileId, src, alt, title, width, height, adaptive });
      tr.replaceWith(position, position + 1, schema.nodes.paragraph.create(null, image));
      selectAt = position + 1;
    }
    try {
      tr.setSelection(NodeSelection.create(tr.doc, selectAt));
    } catch {
      // The schema fitted the image elsewhere; keep the mapped selection.
    }
    editor.view.dispatch(tr);
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
      // Keep the on-page scale: the kept region stays the size it was before cropping.
      const shownWidth = (node.attrs.width as number | null) || image.current?.offsetWidth || 0;
      const width = shownWidth ? Math.max(1, Math.round(shownWidth * crop.width)) : null;
      const height = width ? Math.max(1, Math.round(width * canvas.height / canvas.width)) : null;
      updateAttributes({ fileId: saved.id, src: null, width, height });
      setCropOpen(false);
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  };

  return (
    <NodeViewWrapper as={isInline ? "span" : "div"} contentEditable={false} className="note-image-block" data-inline={isInline || undefined} data-wrap={layout === "wrap" || undefined} data-selected={selected} data-align={isInline ? undefined : node.attrs.alignment}>
      {isInline
        ? <span ref={host as RefObject<HTMLSpanElement>} className="note-image-host" data-drag-handle onClick={selectImage} />
        : <div ref={host as RefObject<HTMLDivElement>} className="note-image-host" data-drag-handle onClick={selectImage} />}
      {(!src || failed) && <span className="text-sm text-muted-foreground">Image unavailable</span>}
      {selected && editor.isEditable && (
        <div className="note-image-controls" aria-label="Image controls" contentEditable={false}>
          <div className="note-image-toolbar">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="ghost" disabled={!src || failed} />}>
                Size<ChevronDown data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-auto">
                {IMAGE_SIZES.map(([fraction, label]) => (
                  <DropdownMenuItem key={label} onClick={() => resizeTo(fraction)}>{label}</DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateAttributes({ width: null, height: null })}>Original size</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="note-image-divider" />
            {IMAGE_LAYOUTS.map(([value, label, hint, Icon]) => (
              <ToolbarButton key={value} label={label} hint={hint} pressed={layout === value} onClick={() => setLayout(value)}><Icon /></ToolbarButton>
            ))}
            {!isInline && <span className="note-image-divider" />}
            {!isInline && IMAGE_ALIGNMENTS.filter(([alignment]) => layout !== "wrap" || alignment !== "center").map(([alignment, label, Icon]) => (
              <ToolbarButton key={alignment} label={layout === "wrap" ? `Image on the ${alignment}, text beside it` : label} pressed={node.attrs.alignment === alignment} onClick={() => updateAttributes({ alignment })}><Icon /></ToolbarButton>
            ))}
            <span className="note-image-divider" />
            <ToolbarButton label="Adapt to theme" hint="Swaps the image's background for the page's and recolors it for dark or light mode" pressed={adaptive} disabled={!src || failed} onClick={() => updateAttributes({ adaptive: !adaptive })}><Contrast /></ToolbarButton>
            <ToolbarButton label="Crop" disabled={!src || failed || !node.attrs.fileId} onClick={() => setCropOpen(true)}><Crop /></ToolbarButton>
            <ToolbarButton label="Alt text and title" pressed={describing} onClick={() => setDescribing((open) => !open)}><Captions /></ToolbarButton>
            <span className="note-image-divider" />
            <ToolbarButton label="Remove image" onClick={deleteNode}><Trash2 /></ToolbarButton>
          </div>
          {describing && (
            <div className="note-image-description">
              <label>Alt text<input key={`alt-${node.attrs.alt}`} defaultValue={node.attrs.alt ?? ""} placeholder="Describe the image" onBlur={(event) => { if (event.target.value !== (node.attrs.alt ?? "")) updateAttributes({ alt: event.target.value }); }} /></label>
              <label>Title<input key={`title-${node.attrs.title}`} defaultValue={node.attrs.title ?? ""} placeholder="Shown when hovering over the image" onBlur={(event) => { if (event.target.value !== (node.attrs.title ?? "")) updateAttributes({ title: event.target.value }); }} /></label>
            </div>
          )}
        </div>
      )}
      {cropOpen && image.current && <CropDialog image={image.current} onCancel={() => setCropOpen(false)} onSave={applyCrop} />}
    </NodeViewWrapper>
  );
}

const SWAP_FADE_MS = 220;

// Shows `next` in place of the image's current picture: fades in a hidden
// image, otherwise crossfades by fading a copy of the old picture out on top.
function swapImage(img: HTMLImageElement, next: string) {
  const hidden = img.style.opacity === "0";
  img.style.opacity = "";
  if (img.src === next) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !img.isConnected) {
    img.src = next;
    return;
  }
  if (hidden) {
    img.src = next;
    img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SWAP_FADE_MS, easing: "ease-out" });
    return;
  }
  // The resize wrapper is positioned, so the copy can sit exactly over the image.
  const ghost = img.cloneNode() as HTMLImageElement;
  Object.assign(ghost.style, {
    position: "absolute",
    left: `${img.offsetLeft}px`,
    top: `${img.offsetTop}px`,
    width: `${img.offsetWidth}px`,
    height: `${img.offsetHeight}px`,
    margin: "0",
    outline: "none",
    pointerEvents: "none",
  });
  ghost.removeAttribute("loading");
  img.insertAdjacentElement("afterend", ghost);
  img.src = next;
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SWAP_FADE_MS, easing: "ease-in-out" })
    .finished.finally(() => ghost.remove());
}

type ImageLayout = "inline" | "wrap" | "break";

const IMAGE_NODES = new Set(["image", "inlineImage"]);

// Puts the cursor in the text flowing beside a wrapped image: at the end of
// the last text block that starts above the click, or in a new paragraph when
// nothing follows the image yet.
function placeCursorBeside(view: EditorView, imagePos: number, imageSize: number, y: number) {
  const after = imagePos + imageSize;
  const $after = view.state.doc.resolve(after);
  const parent = $after.parent;
  let target: number | null = null;
  let offset = after;
  for (let index = $after.index(); index < parent.childCount; index++) {
    const child = parent.child(index);
    if (!child.isTextblock) break;
    const dom = view.nodeDOM(offset);
    // The first block starts level with the image, so it always qualifies.
    if (target !== null && (!(dom instanceof HTMLElement) || dom.getBoundingClientRect().top > y)) break;
    target = offset + child.nodeSize - 1;
    offset += child.nodeSize;
  }
  const tr = view.state.tr;
  if (target === null) {
    tr.insert(after, view.state.schema.nodes.paragraph.create());
    target = after + 1;
  }
  tr.setSelection(TextSelection.create(tr.doc, target));
  view.dispatch(tr);
  view.focus();
}

// Typing replaces a selected node, so a selected image would be overwritten.
// Send the text where it reads next to the image instead.
function typeBesideImage(view: EditorView, selection: NodeSelection, text: string) {
  const { node, from } = selection;
  const after = from + node.nodeSize;
  if (node.type.isInline) {
    const tr = view.state.tr.insertText(text, after);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + text.length)));
    return;
  }
  if (node.attrs.wrap) {
    const block = (view.nodeDOM(from) as HTMLElement | null)?.querySelector(".note-image-block");
    placeCursorBeside(view, from, node.nodeSize, block?.getBoundingClientRect().bottom ?? 0);
    view.dispatch(view.state.tr.insertText(text));
    return;
  }
  // Text below an image on its own line starts a new line of its own.
  const tr = view.state.tr.insert(after, view.state.schema.nodes.paragraph.create(null, view.state.schema.text(text)));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1 + text.length)));
}

// Handles typing on a selected image, and clicks in the blank space beside a
// floated image, which belongs to no text block: the browser would resolve
// those clicks into the image itself.
function imageTextPlugin(type: NodeType) {
  return new Plugin({
    key: new PluginKey("image-text"),
    props: {
      handleTextInput(view, _from, _to, text) {
        const { selection } = view.state;
        if (!(selection instanceof NodeSelection) || !IMAGE_NODES.has(selection.node.type.name)) return false;
        typeBesideImage(view, selection, text);
        return true;
      },
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0 || event.target !== view.dom || !view.editable) return false;
          let handled = false;
          view.state.doc.descendants((node, pos) => {
            if (handled) return false;
            if (node.type !== type || !node.attrs.wrap) return;
            const dom = view.nodeDOM(pos);
            const block = dom instanceof HTMLElement ? dom.querySelector(".note-image-block") ?? dom : null;
            if (!block) return false;
            const box = block.getBoundingClientRect();
            if (event.clientY < box.top || event.clientY > box.bottom) return false;
            const textSide = node.attrs.alignment === "right" ? event.clientX < box.left : event.clientX > box.right;
            if (!textSide) return false;
            placeCursorBeside(view, pos, node.nodeSize, event.clientY);
            handled = true;
            return false;
          });
          if (handled) event.preventDefault();
          return handled;
        },
      },
    },
  });
}

const IMAGE_LAYOUTS = [
  ["inline", "In line", "Sits inside one line of text, like a large letter", TextCursorInput],
  ["wrap", "Wrap text", "Text flows beside the image over several lines", WrapText],
  ["break", "Break text", "Image on its own line, no text beside it", BetweenHorizontalStart],
] as const;

const IMAGE_ALIGNMENTS = [
  ["left", "Align left", AlignLeft],
  ["center", "Align center", AlignCenter],
  ["right", "Align right", AlignRight],
] as const;

const IMAGE_SIZES = [
  [0.25, "Small · 25%"],
  [0.5, "Medium · 50%"],
  [0.75, "Large · 75%"],
  [1, "Full width"],
] as const;

function ToolbarButton({ label, hint, pressed, disabled, onClick, children }: {
  label: string;
  hint?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {hint ? <span className="grid gap-0.5"><strong className="font-medium">{label}</strong><span className="text-muted-foreground">{hint}</span></span> : label}
      </TooltipContent>
    </Tooltip>
  );
}

export const SavedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: { default: null, rendered: false },
      // Blends the image into the theme; see image-adapt.ts.
      adaptive: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-adaptive"),
        renderHTML: (attributes) => (attributes.adaptive ? { "data-adaptive": "" } : {}),
      },
      alignment: {
        default: "left",
        parseHTML: (element) => element.getAttribute("data-align") || "left",
        renderHTML: (attributes) => ({
          "data-align": attributes.alignment,
          style: `display: block; margin-left: ${attributes.alignment === "left" ? "0" : "auto"}; margin-right: ${attributes.alignment === "right" ? "0" : "auto"}`,
        }),
      },
      // Floats the image so the following text flows around it.
      wrap: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-wrap"),
        renderHTML: (attributes) =>
          attributes.wrap
            ? { "data-wrap": "", style: `float: ${attributes.alignment === "right" ? "right" : "left"}` }
            : {},
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(SavedImageView);
  },
  addProseMirrorPlugins() {
    return [imageTextPlugin(this.type)];
  },
});

// The same image, placed within a line of text instead of on its own line.
export const InlineImage = SavedImage.extend({
  name: "inlineImage",
  inline: true,
  group: "inline",
  addAttributes() {
    const { alignment: _alignment, wrap: _wrap, ...attributes } = (this.parent?.() ?? {}) as Record<string, unknown>;
    return attributes;
  },
  parseHTML() {
    return [{ tag: "img[src][data-inline-image]", priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-inline-image": "" })];
  },
  // The block image already owns the markdown input rule and setImage.
  addInputRules() {
    return [];
  },
  addCommands() {
    return {};
  },
  // SavedImage's plugin covers both node types; plugin keys must be unique.
  addProseMirrorPlugins() {
    return [];
  },
});
