import { TAP_DURATION_MS, TAP_MOVEMENT_PX, DOUBLE_TAP_MS, DOUBLE_TAP_DISTANCE_PX } from "@/lib/pointer-gestures";
import { useEditorHost } from "@/lib/editor-host-context";
import { parsePdfSource } from "@/lib/pdf-quote";
import { PdfSourceCaption } from "./pdf-source-caption";
import { Menu } from "@base-ui/react/menu";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { SavedImage as ImageSchema, InlineImage as InlineImageSchema } from "@/lib/editor-schema/images";
import { occlusionCardId } from "@/lib/card-id";
import { ImageActionsMenu, ImagePreviewDialog } from "@/components/image-actions-menu";
import { imageOperation, isWriteAdmitted, type WritePermit } from "@/lib/write-lifecycle";
import { OcclusionEditor } from "@/components/occlusion-editor";
import { maskCards, validMasks } from "@/lib/occlusion";
import { cardInfo, cardSchedulesOf } from "@/lib/flashcards";
import { CropDialog, type Crop as ImageCrop } from "./image-crop-dialog";
import { copyImageAttrs } from "@/lib/editor-schema/images";
import { figureNumbers } from "@/lib/figure-numbering";
import { headingNumberingKey } from "@/lib/heading-numbering";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { NodeViewWrapper, useEditorState, type NodeViewProps } from "@tiptap/react";
import { ResizableNodeView } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { call as invoke, fileUrl as convertFileSrc, isTauri, postNativeEvent } from "../lib/backend.ts";
import { AlignLeft, AlignCenter, AlignRight, BetweenHorizontalStart, Captions, ChevronRight, Scan, Scaling, Contrast, Crop, Maximize2, LoaderCircle, Pencil, TextCursorInput, Trash2, WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import type { FileType } from "@/lib/content";
import { startImagePointerMove } from "@/lib/image-pointer-move";
import { adaptedUrl, cachedAdaptedUrl, scheduleTrim } from "@/lib/image-adapt";
import { useDarkTheme } from "@/hooks/use-dark-theme";
import { useSelector } from "@tanstack/react-store";
import { requestSyncedFile, syncedFilesStore } from "@/lib/sync/file-requests";
import { isLocallyPublishedPreview } from "@/editor-host/drawings";
import { drawingReference } from "@/lib/drawing";
import { IS_MAC } from "@/lib/platform";
import { ImageControlsLayer } from "./image-controls-layer";
import "./saved-image.css";

type FilesContextValue = {
  flashcards?: boolean;
  worksheet?: boolean;
  editDrawing?: (imageId: string, sourceId: string | null) => void;
  /** Drawing whose newer strokes are only in a local draft; shown with an "Unsaved" badge. */
  unsavedDrawingId?: string | null;
  moduleId?: string;
  files: ReadonlyMap<string, FileType>;
  saveImage: (file: File, permit?: WritePermit) => Promise<FileType>;
  readImage: (fileId: string) => Promise<Blob>;
};

export const FilesContext = createContext<FilesContextValue>({
  files: new Map(),
  saveImage: async () => { throw new Error("Image storage is unavailable"); },
  readImage: async () => { throw new Error("Image storage is unavailable"); },
});

const visiblePreviews = new Set<HTMLElement>();
const worksheetPreviewSizes = new Map<string, { width: number; height: number }>();

export function SavedImageView(props: NodeViewProps) {
  const environment = useEditorHost();
  const isNativeTablet = environment.isNative && document.documentElement.classList.contains("native-tablet");
  const { node, editor, updateAttributes, deleteNode } = props;
  const selected = useEditorState({
    editor,
    selector: ({ editor }) => {
      const selection = editor.state.selection;
      return selection instanceof NodeSelection && selection.from === props.getPos();
    },
  });
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption.trim() : "";
  const [editingCaption, setEditingCaption] = useState(false);
  const figureNumber = useEditorState({
    editor,
    selector: ({ editor }) => {
      const pos = props.getPos();
      if (pos === undefined || (!caption && !editingCaption)) return null;
      const { state } = editor;
      return figureNumbers(state.doc, !!headingNumberingKey.getState(state)).get(pos) ?? null;
    },
  });
  const finishCaption = (value: string) => {
    setEditingCaption(false);
    if (!editor.isEditable || editor.isDestroyed || !isWriteAdmitted()) return;
    const pos = props.getPos();
    if (pos !== undefined && editor.state.doc.nodeAt(pos) === node && value !== caption) {
      updateAttributes({ caption: value || null });
    }
  };
  const { files, saveImage, readImage, moduleId, editDrawing, unsavedDrawingId, flashcards = true, worksheet = false } = useContext(FilesContext);
  const drawing = drawingReference(node.attrs.drawing);
  const macDrawing = !!drawing && IS_MAC && isTauri();
  const drawingAdapts = !!drawing && (environment.isNative || macDrawing);
  const canEditDrawing = !!drawing && (environment.isNative || !!editDrawing);
  const previewId = drawing?.previewId ?? node.attrs.fileId;
  const file = files.get(previewId);
  const [resolved, setResolved] = useState<{ id: string; path: string }>();
  // An image from another device may still be downloading; look again when one arrives.
  const syncedFiles = useSelector(syncedFilesStore, (state) => state.version);
  useEffect(() => {
    let active = true;
    if (!file && previewId) void invoke<string>("resolve_card_image", { fileId: previewId }).then(path => {
      if (active) setResolved({ id: previewId, path });
    }).catch(() => {
      if (!active) return;
      requestSyncedFile(previewId);
    });
    return () => { active = false; };
  }, [file, previewId, syncedFiles]);
  const currentSrc = file ? convertFileSrc(file.path) : resolved && resolved.id === previewId ? convertFileSrc(resolved.path) : (drawing?.previewId ? null : node.attrs.src);
  const imageId = typeof node.attrs.imageId === "string" ? node.attrs.imageId : null;
  const drawingPreviewId = drawing?.previewId;
  const pictureKey = imageId && JSON.stringify([moduleId, imageId]);
  // A sync rebuild can remount the view mid-update. Restore the last picture
  // together with the dimensions it was displayed at.
  const [picture, setPicture] = useState(() => drawingPreviewId && pictureKey ? lastDrawingPicture.get(pictureKey) : undefined);
  const showingPrevious = !!(drawingPreviewId && picture && picture.previewId !== drawingPreviewId);
  const width = showingPrevious ? picture.width : node.attrs.width;
  const height = showingPrevious ? picture.height : node.attrs.height;
  const src = currentSrc || (drawingPreviewId ? picture?.src : null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = !!currentSrc && failedSource === currentSrc;
  const waitingForPicture = !!drawingPreviewId && !picture && !failed;
  const loading = waitingForPicture || (showingPrevious && !failed && !worksheet && !isLocallyPublishedPreview(drawingPreviewId));
  const rememberPicture = (source: string, naturalWidth: number, naturalHeight: number) => {
    if (!drawingPreviewId) return;
    if (worksheet && naturalWidth && naturalHeight) {
      rememberPreview(worksheetPreviewSizes, drawingPreviewId, { width: naturalWidth, height: naturalHeight });
    }
    const attrs = latest.current.node.attrs;
    setPicture({ src: source, previewId: drawingPreviewId, width: attrs.width, height: attrs.height, naturalWidth, naturalHeight });
  };
  const isInline = node.type.isInline;
  const host = useRef<HTMLElement>(null);
  const inTableCell = useEditorState({
    editor,
    selector: ({ editor }) => {
      const position = props.getPos();
      if (position === undefined) return false;
      const $pos = editor.state.doc.resolve(position);
      for (let depth = $pos.depth; depth > 0; depth--) {
        if (["tableCell", "tableHeader"].includes($pos.node(depth).type.name)) return true;
      }
      return false;
    },
  });
  // clientWidth includes padding, which belongs to the cell, not its image.
  // Re-read on every drag update so scrolling/resizing the editor stays safe.
  const getAvailableWidth = () => {
    const block = host.current?.closest<HTMLElement>(".note-image-block");
    const container = block?.closest<HTMLElement>("td, th") ?? block?.parentElement;
    if (!container) return 0;
    const style = getComputedStyle(container);
    return Math.max(0, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  };
  const image = useRef<HTMLImageElement | null>(null);
  const [controlsAnchor, setControlsAnchor] = useState<HTMLElement | null>(null);
  const mounted = useRef(true);
  // Ends an image drag still in progress if this view goes away (editor destroyed).
  const cancelMove = useRef<(() => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelMove.current?.(); };
  }, []);
  const latest = useRef(props);
  latest.current = props;
  const [occlusionOpen, setOcclusionOpen] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Mounted from the first opening on (so closing still animates); a note with
  // many images otherwise builds a closed dialog for each one as it opens.
  const previewMounted = useRef(false);
  if (previewOpen) previewMounted.current = true;
  const previewElement = useRef<HTMLElement | null>(null);
  // Popup refs follow the portal's actual lifetime, including its exit animation.
  const reportPreview = useCallback((element: HTMLDivElement | null) => {
    const wasOpen = visiblePreviews.size > 0;
    if (previewElement.current) visiblePreviews.delete(previewElement.current);
    previewElement.current = element;
    if (element) visiblePreviews.add(element);
    const open = visiblePreviews.size > 0;
    if (open !== wasOpen) postNativeEvent("imagePreview", { open });
  }, []);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const openDrawing = () => {
    if (!drawing || !moduleId || !editor.isEditable) return;
    if (editDrawing) editDrawing(node.attrs.imageId, drawing.sourceId);
    else if (environment.isNative) postNativeEvent("editDrawing", { moduleId, imageId: node.attrs.imageId, sourceId: drawing.sourceId });
  };
  const imagePress = useRef<{ id: number; time: number; x: number; y: number; selectedAtStart: boolean } | null>(null);
  const endImageTap = (event: ReactPointerEvent, cancelled = false) => {
    const down = imagePress.current;
    imagePress.current = null;
    if (!down || down.id !== event.pointerId) return;
    if (cancelled || event.timeStamp - down.time > TAP_DURATION_MS || Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_MOVEMENT_PX) { lastTap.current = null; return; }
    if (canEditDrawing && editor.isEditable) {
      event.preventDefault();
      cancelMove.current?.();
      if (down.selectedAtStart) openDrawing(); else selectImage();
      return;
    }
    const previous = lastTap.current;
    lastTap.current = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    if (!previous || event.timeStamp - previous.time > DOUBLE_TAP_MS || Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > DOUBLE_TAP_DISTANCE_PX || !src || failed) return;
    event.preventDefault();
    cancelMove.current?.();
    lastTap.current = null;
    setPreviewOpen(true);
  };
  // The viewer shares the decoded copy shown in the note, including recoloring.
  const [displayedImage, setDisplayedImage] = useState<{ source: string; url: string } | null>(null);
  const [describing, setDescribing] = useState(false);
  const dark = useDarkTheme();
  const adaptive = drawingAdapts || Boolean(node.attrs.adaptive);

  // The image's cards get the dot text cards have: due state and schedule on
  // hover, and a way into the mask editor.
  const schedules = useEditorState({ editor, selector: ({ editor }) => cardSchedulesOf(editor.state) });
  const infoHost = useRef<HTMLSpanElement>(null);
  const canEditMasks = flashcards && editor.isEditable && !!src && !failed && !!node.attrs.fileId;
  useEffect(() => {
    const element = infoHost.current;
    if (!element) return;
    const { imageId, fileId } = node.attrs;
    const masks = validMasks(node.attrs.masks);
    if (!flashcards || isInline || typeof imageId !== "string" || typeof fileId !== "string" || !masks.length || !schedules) {
      element.replaceChildren();
      return;
    }
    // Numbered as in the mask editor.
    const entries = maskCards(masks).map(({ owner, members }, index) => ({
      answer: members.length > 1 ? `Card ${index + 1} (${members.length} masks)` : `Card ${index + 1}`,
      schedule: schedules.byId.get(occlusionCardId(imageId, owner.id)),
    }));
    const due = entries.some(({ schedule }) => schedule && schedule.dueAt <= schedules.now);
    element.replaceChildren(cardInfo(entries, due, schedules.now,
      canEditMasks ? { label: "Edit masks", run: () => setOcclusionOpen(true) } : null));
  }, [schedules, node.attrs.imageId, node.attrs.fileId, node.attrs.masks, isInline, canEditMasks, flashcards]);

  const hasSrc = !!src;
  // Preview revisions must not detach editor DOM while a text caret is active.
  useLayoutEffect(() => {
    if (!host.current || !hasSrc) {
      setControlsAnchor(null);
      return;
    }
    const img = document.createElement("img");
    image.current = img;
    img.className = "note-image";
    img.draggable = false;
    img.loading = "lazy";
    img.decoding = "async";
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
    setControlsAnchor(img.parentElement);
    return () => {
      img.onload = null;
      img.onerror = null;
      view.destroy();
      image.current = null;
      // It may have been showing a cached copy that can now be evicted.
      scheduleTrim();
    };
  }, [hasSrc, editor]);

  useLayoutEffect(() => {
    const img = image.current;
    if (!img || !src) return;
    setFailedSource(null);
    // Retain the decoded old preview until the source effect below swaps it.
    if (!img.getAttribute("src") && picture) {
      // The source effect below crossfades to the new preview once it decodes.
      if (macDrawing) img.loading = "eager";
      img.src = (adaptive && cachedAdaptedUrl(picture.previewId, dark)) || picture.src;
      setDisplayedImage({ source: picture.src, url: img.src });
    } else if (!img.getAttribute("src")) {
      if (adaptive) {
        // Hide the original until its recolored copy is ready.
        const cached = cachedAdaptedUrl(previewId ?? src, dark);
        if (cached) img.src = cached;
        else {
          img.src = src;
          img.style.opacity = "0";
        }
      } else img.src = src;
      setDisplayedImage({ source: src, url: img.style.opacity === "0" ? "" : img.src });
    }
    img.onerror = () => setFailedSource(src);
    img.onload = () => {
      setFailedSource(null);
      const showsCurrent = currentSrc && (img.src === new URL(currentSrc, location.href).href || img.src === cachedAdaptedUrl(drawingPreviewId ?? currentSrc, dark));
      if (showsCurrent && img.style.opacity !== "0") {
        rememberPicture(currentSrc, img.naturalWidth, img.naturalHeight);
      }
    };
    return () => { img.onload = null; img.onerror = null; };
  }, [src, currentSrc, drawingPreviewId, dark, adaptive, macDrawing]);

  useLayoutEffect(() => {
    if (picture && picture.previewId === drawingPreviewId) {
      if (picture.width !== width || picture.height !== height) {
        setPicture({ ...picture, width, height });
      }
      if (pictureKey) rememberPreview(lastDrawingPicture, pictureKey, { ...picture, width, height });
    }
  }, [pictureKey, picture, drawingPreviewId, width, height]);

  useLayoutEffect(() => {
    if (!image.current) return;
    image.current.alt = node.attrs.alt ?? "";
    image.current.title = node.attrs.title ?? "";
    const previewWidth = width || (macDrawing && picture?.naturalWidth);
    const previewHeight = height || (macDrawing && picture?.naturalHeight);
    image.current.style.width = previewWidth ? `${previewWidth}px` : "";
    image.current.style.height = "auto";
    image.current.style.aspectRatio = previewWidth && previewHeight ? `${previewWidth} / ${previewHeight}` : "";
  }, [src, node.attrs.alt, node.attrs.title, width, height, macDrawing, picture?.naturalWidth, picture?.naturalHeight]);

  // Recolored on the fly rather than saved, so it follows theme changes.
  useEffect(() => {
    const img = image.current;
    if (!img || !currentSrc) return;
    const src = currentSrc;
    const fileId = previewId as string | null;
    const key = fileId ?? src;
    if (img.src === (adaptive ? cachedAdaptedUrl(key, dark) : src)) return;
    let cancelled = false;
    let stopWaiting: (() => void) | undefined;
    let release: (() => void) | undefined;
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
      let next = src;
      if (adaptive) {
        const adapted = adaptedUrl(key, dark, async () => fileId ? readImage(fileId) : (await fetch(src)).blob());
        release = adapted.release;
        next = await adapted.url.catch(() => src);
      }
      // Decode first so the swap never shows an empty frame.
      const probe = document.createElement("img");
      probe.src = next;
      await probe.decode();
      if (!cancelled) {
        await swapImage(img, next, macDrawing ? () => !cancelled : undefined);
        if (cancelled) return;
        setDisplayedImage({ source: src, url: next });
        rememberPicture(src, probe.naturalWidth, probe.naturalHeight);
      }
    })().catch((error) => {
      console.error("Failed to adapt image:", error);
      if (!cancelled) {
        if (!drawingPreviewId) {
          swapImage(img, src);
          setDisplayedImage({ source: src, url: src });
        } else {
          setFailedSource(src);
        }
      }
    }).finally(() => release?.());
    return () => {
      cancelled = true;
      stopWaiting?.();
      release?.();
    };
  }, [currentSrc, adaptive, dark, previewId, readImage, macDrawing]);

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
      if (!environment.isNative) editor.view.focus();
    }
  };
  // Pressing and dragging the image moves it; a press without moving is a click.
  const pressImage = (event: ReactPointerEvent) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-resize-handle]")) return;
    if (environment.isNative || canEditDrawing) {
      if (!event.isPrimary) { imagePress.current = null; lastTap.current = null; return; }
      // Selection changes on pointer-down; remember its previous state so the
      // first tap selects a drawing and only a subsequent tap opens it.
      const selection = editor.state.selection;
      imagePress.current = { id: event.pointerId, time: event.timeStamp, x: event.clientX, y: event.clientY,
        selectedAtStart: selection instanceof NodeSelection && selection.from === latest.current.getPos() };
    }
    if (!editor.isEditable) return;
    // No text selection or native image drag while the pointer moves.
    event.preventDefault();
    // Select before tracking a touch drag so the native host suppresses its
    // keyboard even when the preceding selection was a text caret.
    if (environment.isNative) selectImage();
    cancelMove.current?.();
    cancelMove.current = startImagePointerMove(editor.view, () => latest.current.getPos(), event.nativeEvent, image.current);
  };

  const layout: ImageLayout = isInline ? "inline" : node.attrs.wrap && !inTableCell ? "wrap" : "break";

  // Mirrors Google Docs' image layouts. A node type is either inline or block,
  // so moving into or out of a line of text replaces the node.
  const setLayout = (target: ImageLayout) => {
    if (target === layout || (inTableCell && target === "wrap")) return;
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
    const attrs = copyImageAttrs(node);
    const tr = state.tr;
    let selectAt: number;
    if (isInline) {
      const image = schema.nodes.image.create({ ...attrs, alignment, wrap });
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
      const image = schema.nodes.inlineImage.create(attrs);
      tr.replaceWith(position, position + 1, schema.nodes.paragraph.create(null, image));
      selectAt = position + 1;
    }
    try {
      tr.setSelection(NodeSelection.create(tr.doc, selectAt));
    } catch (error) {
      console.error("Failed to select image:", error);
      // The schema fitted the image elsewhere; keep the mapped selection.
    }
    editor.view.dispatch(tr);
  };

  const applyCrop = (crop: ImageCrop) => imageOperation(async permit => {
    if (!isWriteAdmitted(permit) || editor.isDestroyed) throw new Error("Image writes are suspended");
    const fileId = node.attrs.fileId as string | null;
    if (!fileId) throw new Error("This image cannot be read for cropping");
    const original = await readImage(fileId);
    if (!isWriteAdmitted(permit) || editor.isDestroyed) throw new Error("Image writes are suspended");
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
      const saved = await saveImage(new File([blob], `${node.attrs.alt || "image"}-cropped.png`, { type: "image/png" }), permit);
      if (!isWriteAdmitted(permit) || editor.isDestroyed) throw new Error("Image writes are suspended");
      const position = latest.current.getPos();
      if (!mounted.current || position === undefined || editor.state.doc.nodeAt(position) !== node) {
        throw new Error("The crop target changed. Reopen the image and reapply the crop, then discard this failed operation.");
      }
      // Keep the on-page scale: the kept region stays the size it was before cropping.
      const shownWidth = (node.attrs.width as number | null) || image.current?.offsetWidth || 0;
      const width = shownWidth ? Math.max(1, Math.round(shownWidth * crop.width)) : null;
      const height = width ? Math.max(1, Math.round(width * canvas.height / canvas.width)) : null;
      const provenance = parsePdfSource(node.attrs.pdfSource);
      const pdfSource = provenance ? { ...provenance, region: {
        x: provenance.region.x + crop.x * provenance.region.width,
        y: provenance.region.y + crop.y * provenance.region.height,
        width: provenance.region.width * crop.width,
        height: provenance.region.height * crop.height,
      } } : null;
      updateAttributes({ fileId: saved.id, src: null, width, height, masks: [], pdfSource });
      setCropOpen(false);
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  });

  const hasImage = !!src && !failed;
  const canCrop = !drawing && hasImage && !!node.attrs.fileId;
  const previewSize = drawing && (width > 0 && height > 0
    ? { width, height }
    : drawingPreviewId && worksheetPreviewSizes.get(showingPrevious ? picture.previewId : drawingPreviewId));
  const drawingSize = previewSize
    ? { "--drawing-width": `${previewSize.width}px`, "--drawing-ratio": `${previewSize.width} / ${previewSize.height}` } as CSSProperties
    : undefined;
  return (
    <NodeViewWrapper style={drawingSize} data-drawing={drawing ? true : undefined} as={isInline ? "span" : "div"} contentEditable={false} className="note-image-block" data-loading={waitingForPicture || undefined} aria-busy={loading || undefined} data-inline={isInline || undefined} data-wrap={layout === "wrap" || undefined} data-selected={selected} data-range-selected={props.selected && !selected || undefined} data-align={isInline ? undefined : node.attrs.alignment}>
      <span ref={infoHost} className="contents" />
      {isInline
        ? <span ref={host as RefObject<HTMLSpanElement>} className="note-image-host" onPointerDown={pressImage} onPointerMove={event => { const down = imagePress.current; if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_MOVEMENT_PX) { imagePress.current = null; lastTap.current = null; } }} onPointerUp={event => endImageTap(event)} onPointerCancel={event => endImageTap(event, true)} onClick={selectImage} onDoubleClick={() => { if (!environment.isNative && !canEditDrawing && src && !failed) { setPreviewOpen(true); } }} />
        : <div ref={host as RefObject<HTMLDivElement>} className="note-image-host" onPointerDown={pressImage} onPointerMove={event => { const down = imagePress.current; if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_MOVEMENT_PX) { imagePress.current = null; lastTap.current = null; } }} onPointerUp={event => endImageTap(event)} onPointerCancel={event => endImageTap(event, true)} onClick={selectImage} onDoubleClick={() => { if (!environment.isNative && !canEditDrawing && src && !failed) { setPreviewOpen(true); } }} />}
      {drawing && unsavedDrawingId && unsavedDrawingId === node.attrs.imageId && !loading && <span className="note-image-unsaved" title="Open the drawing to continue; its newest strokes are not saved yet.">Unsaved changes</span>}
      {loading && <span className="note-image-loading" role="status"><LoaderCircle className="animate-spin motion-reduce:animate-none" size={20} /><span>{drawing ? "Updating drawing…" : "Loading image…"}</span></span>}
      {(!src || failed) && !loading && (drawing
        ? <Button variant="outline" onClick={openDrawing}>{canEditDrawing ? "Open drawing" : "Drawing (edit on iPad)"}</Button>
        : <span className="text-sm text-muted-foreground">Image unavailable</span>)}
      {node.attrs.pdfSource && <PdfSourceCaption value={node.attrs.pdfSource} />}
      {editingCaption && editor.isEditable ? (
        <span className="note-image-caption" data-empty={!caption || undefined}>
          <span className="note-image-caption-edit">
            <span>Figure {figureNumber}</span>
            <input
              aria-label="Image caption"
              autoFocus
              defaultValue={caption}
              key={caption}
              placeholder="Caption"
              onBlur={event => finishCaption(event.currentTarget.value.trim())}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") event.currentTarget.value = caption;
                if (event.key === "Enter" || event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                  editor.view.focus();
                }
              }}
            />
          </span>
        </span>
      ) : caption ? (
        <span className="note-image-caption">
          {editor.isEditable
            ? <button type="button" onClick={() => setEditingCaption(true)}>Figure {figureNumber}: {caption}</button>
            : <>Figure {figureNumber}: {caption}</>}
        </span>
      ) : selected && editor.isEditable && (
        <span className="note-image-caption" data-empty>
          <Button size="xs" variant="ghost" onClick={() => setEditingCaption(true)}>Add caption</Button>
        </span>
      )}
      {selected && editor.isEditable && (
        <ImageControlsLayer anchor={controlsAnchor}>
          <ImageActionsMenu label="Image actions" className="note-image-actions-menu w-60" sideOffset={isNativeTablet ? 10 : undefined} finalFocus={environment.isNative ? false : () => editor.isDestroyed ? null : editor.view.dom}>
              {isNativeTablet && canEditDrawing && <DropdownMenuItem onClick={openDrawing}><Pencil />Edit drawing</DropdownMenuItem>}
              {(!isNativeTablet || hasImage) && <DropdownMenuItem disabled={!hasImage} onClick={() => setPreviewOpen(true)}><Maximize2 />Open image full screen</DropdownMenuItem>}
              {(!isNativeTablet || canEditDrawing || hasImage) && <DropdownMenuSeparator />}
              {(!isNativeTablet || hasImage) && <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger render={<DropdownMenuItem />} disabled={!hasImage}><Scaling />Size<ChevronRight className="ml-auto" /></Menu.SubmenuTrigger>
                <DropdownMenuContent side="inline-end" align="start" sideOffset={2} alignOffset={-4} className="note-image-actions-submenu w-48">
                  {IMAGE_SIZES.map(([fraction, label]) => <DropdownMenuItem key={label} onClick={() => resizeTo(fraction)}>{label}</DropdownMenuItem>)}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => updateAttributes({ width: null, height: null })}>Original size</DropdownMenuItem>
                </DropdownMenuContent>
              </Menu.SubmenuRoot>}
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger render={<DropdownMenuItem />}><WrapText />Text wrapping<ChevronRight className="ml-auto" /></Menu.SubmenuTrigger>
                <DropdownMenuContent side="inline-end" align="start" sideOffset={2} alignOffset={-4} className="note-image-actions-submenu w-48">
                  <DropdownMenuRadioGroup value={layout}>
                    {IMAGE_LAYOUTS.filter(([value]) => !isNativeTablet || !inTableCell || value !== "wrap").map(([value, label, hint, Icon]) => <DropdownMenuRadioItem closeOnClick key={value} value={value} title={hint} disabled={inTableCell && value === "wrap"} onClick={() => setLayout(value)}><Icon />{label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </Menu.SubmenuRoot>
              {!isInline && <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger render={<DropdownMenuItem />}><AlignLeft />Alignment<ChevronRight className="ml-auto" /></Menu.SubmenuTrigger>
                <DropdownMenuContent side="inline-end" align="start" sideOffset={2} alignOffset={-4} className="note-image-actions-submenu w-60">
                  <DropdownMenuRadioGroup value={node.attrs.alignment}>
                    {IMAGE_ALIGNMENTS.filter(([alignment]) => layout !== "wrap" || alignment !== "center").map(([alignment, label, Icon]) => <DropdownMenuRadioItem closeOnClick key={alignment} value={alignment} onClick={() => updateAttributes({ alignment })}><Icon />{layout === "wrap" ? `Image on the ${alignment}, text beside it` : label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </Menu.SubmenuRoot>}
              {!drawingAdapts && (!isNativeTablet || hasImage) && <DropdownMenuItem disabled={!src || failed} onClick={() => updateAttributes({ adaptive: !adaptive })}><Contrast />{adaptive ? "Stop adapting to theme" : "Adapt to theme"}</DropdownMenuItem>}
              {!isNativeTablet && <DropdownMenuSeparator />}
              {flashcards && (!isNativeTablet || canCrop) && <DropdownMenuItem disabled={!canCrop} onClick={() => setOcclusionOpen(true)}><Scan />Occlusion ({validMasks(node.attrs.masks).length})</DropdownMenuItem>}
              {(!isNativeTablet || canCrop) && <DropdownMenuItem disabled={!canCrop} onClick={() => { if (!validMasks(node.attrs.masks).length || window.confirm("Applying a crop resets all occlusion masks and retires their cards. Undo restores them. Continue to crop?")) setCropOpen(true); }}><Crop />Crop</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => setDescribing(open => !open)}><Captions />Alt text and title</DropdownMenuItem>
              {!isNativeTablet && drawing && <DropdownMenuItem disabled={!canEditDrawing} onClick={openDrawing}><Pencil />{canEditDrawing ? "Edit drawing" : "Edit on iPad"}</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={deleteNode}><Trash2 />Remove image</DropdownMenuItem>
          </ImageActionsMenu>
          {describing && (
            <span className="note-image-description">
              <label>Alt text<input key={`alt-${node.attrs.alt}`} defaultValue={node.attrs.alt ?? ""} placeholder="Describe the image" onBlur={(event) => { if (event.target.value !== (node.attrs.alt ?? "")) updateAttributes({ alt: event.target.value }); }} /></label>
              <label>Title<input key={`title-${node.attrs.title}`} defaultValue={node.attrs.title ?? ""} placeholder="Shown when hovering over the image" onBlur={(event) => { if (event.target.value !== (node.attrs.title ?? "")) updateAttributes({ title: event.target.value }); }} /></label>
            </span>
          )}
        </ImageControlsLayer>
      )}
      {occlusionOpen && src && <OcclusionEditor src={src} masks={validMasks(node.attrs.masks)} onCancel={() => setOcclusionOpen(false)} onSave={masks => { if (!isWriteAdmitted() || editor.isDestroyed || !editor.isEditable) return; updateAttributes({ masks, imageId: node.attrs.imageId || crypto.randomUUID() }); setOcclusionOpen(false); }} />}
      {cropOpen && image.current && <CropDialog image={image.current} onCancel={() => setCropOpen(false)} onSave={applyCrop} />}
      {src && previewMounted.current && (
        <ImagePreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          contentRef={reportPreview}
          // Focusing the native contenteditable materializes the image's node
          // range as iOS text-selection handles, including its control toolbar.
          // Keep the node outline without requesting text input on return.
          finalFocus={environment.isNative ? false : () => editor.isDestroyed ? null : editor.view.dom}
          src={displayedImage && (drawing || displayedImage.source === src) && displayedImage.url ? displayedImage.url : undefined}
          alt={node.attrs.alt || node.attrs.title || "Image"}
        />
      )}
    </NodeViewWrapper>
  );
}

const SWAP_FADE_MS = 220;
// Last loaded preview per drawing (imageId), so a remounted view never blanks.
const lastDrawingPicture = new Map<string, { src: string; previewId: string; width: number | null; height: number | null; naturalWidth: number; naturalHeight: number }>();

function rememberPreview<T>(cache: Map<string, T>, id: string, value: T) {
  cache.delete(id);
  cache.set(id, value);
  if (cache.size > 128) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// Shows `next` in place of the image's current picture: fades in a hidden
// image, otherwise crossfades by fading a copy of the old picture out on top.
async function swapImage(img: HTMLImageElement, next: string, stillCurrent?: () => boolean) {
  const hidden = img.style.opacity === "0";
  img.style.opacity = "";
  if (img.src === next) return;
  // Nothing on screen yet (still loading or failed): no crossfade, and no
  // offset reads, which force a layout of the whole note per image on open.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if ((reduceMotion && (!stillCurrent || hidden)) || !img.isConnected || !img.complete || !img.naturalWidth) {
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
  if (stillCurrent) {
    // The Mac WKWebView can briefly clear an image during a source change.
    // Decode the overlay before replacing the visible source.
    await ghost.decode().catch(() => {});
    if (!stillCurrent() || !img.isConnected) return;
  }
  img.insertAdjacentElement("afterend", ghost);
  img.src = next;
  if (stillCurrent) {
    await img.decode().catch(() => {});
    if (reduceMotion || !stillCurrent()) {
      ghost.remove();
      scheduleTrim();
      return;
    }
  }
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SWAP_FADE_MS, easing: "ease-in-out" })
    .finished.finally(() => {
      ghost.remove();
      // The ghost kept the old copy in use.
      scheduleTrim();
    });
}

type ImageLayout = "inline" | "wrap" | "break";

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
  [0.25, "Small (25%)"],
  [0.5, "Medium (50%)"],
  [0.75, "Large (75%)"],
  [1, "Full width"],
] as const;

// Images move with pointer events (see image-pointer-move.ts), never native
// drag and drop: ProseMirror would make the node draggable on mousedown, and
// that drag swallows the click that selects the image and opens its toolbar.
export function imageStopEvent({ event }: { event: Event }) {
  const { type } = event;
  if (event.target instanceof HTMLInputElement && event.target.closest(".note-image-caption")) return true;
  // Other content can still be dropped on or beside the image.
  if (type === "dragover" || type === "dragenter" || type === "drop") return false;
  if (type === "dragstart") { event.preventDefault(); return true; }
  return !["copy", "cut", "paste"].includes(type);
}


// UI entrypoints retained for image-only editors. Headless readers import the schema.
export const SavedImage = ImageSchema.extend({
  addNodeView() { return ReactNodeViewRenderer(SavedImageView, { stopEvent: imageStopEvent }); },
});
export const InlineImage = InlineImageSchema.extend({
  addNodeView() { return ReactNodeViewRenderer(SavedImageView, { stopEvent: imageStopEvent }); },
});
