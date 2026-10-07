import { createContext, useContext, useEffect, useRef, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ResizableNodeView } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlignLeft, AlignCenter, AlignRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileType } from "@/lib/content";

export const FilesContext = createContext<ReadonlyMap<string, FileType>>(new Map());

function SavedImageView(props: NodeViewProps) {
  const { node, selected, editor, updateAttributes, deleteNode } = props;
  const files = useContext(FilesContext);
  const file = files.get(node.attrs.fileId);
  const src = file ? convertFileSrc(file.path) : node.attrs.src;
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);

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
            return host.current?.clientWidth || undefined;
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
    const width = Math.round(host.current.clientWidth * fraction);
    updateAttributes({ width, height: Math.round(width * img.naturalHeight / img.naturalWidth) });
  };

  return (
    <NodeViewWrapper contentEditable={false} className="note-image-block" data-selected={selected} data-align={node.attrs.alignment}>
      <div ref={host} className="note-image-host" data-drag-handle />
      {(!src || failed) && <span className="text-sm text-muted-foreground">Image unavailable</span>}
      {selected && editor.isEditable && (
        <div className="note-image-controls" aria-label="Image controls">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Image size and alignment">
            {[25, 50, 100].map((size) => (
              <Button key={size} size="xs" variant="ghost" onClick={() => resizeTo(size / 100)} disabled={!src || failed} aria-label={`Set image to ${size}% of editor width`}>{size}%</Button>
            ))}
            <Button size="xs" variant="ghost" onClick={() => updateAttributes({ width: null, height: null })}>Original size</Button>
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
