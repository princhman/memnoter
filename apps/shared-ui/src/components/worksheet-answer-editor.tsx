import { registerWorksheetEditor } from "@/editor-host/worksheet-editor";
import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import * as Y from "yjs";
import { noteExtensions, isNoteFromNewerVersion } from "@/lib/editor-schema";
import { isSchemaReadOnly } from "@/lib/guarded-collaboration";
import { watchWriteAdmission } from "@/lib/write-lifecycle";
import type { AnswerDocument } from "@/lib/worksheet-session";
import { InlineMathView } from "./inline-math-view";
import { MathBlockView } from "@/lib/editor-schema/math-block-view";
import { MermaidView } from "@/lib/editor-schema/mermaid-view";
import { LatexSuggest } from "./latex-menu";
import { TextBubbleMenu } from "./text-bubble-menu";
import { LinkMenu } from "./link-menu";
import { SlashCommand } from "./slash-menu";
import { FilesContext, SavedImage, InlineImage } from "./saved-image";
import { beginDrawing, commitDrawing, discardEmptyDrawing } from "@/editor-host/drawings";
import { drawingReference } from "@/lib/drawing";
import { call, capabilities, isNativeHost } from "@/lib/backend";
import type { FileType } from "@/lib/content";
import { assertWritable, writeOperation, type WritePermit } from "@/lib/write-lifecycle";
import { WorksheetDrawings } from "./worksheet-drawings";
import type { Bank } from "@/lib/question-bank";
import { Button } from "./ui/button";

// Same persisted schema and commands as notes, with a private document and no
// note module registration, view persistence, indexing or flashcard side effects.
type DrawingResult = { status: string; source?: FileType; preview?: FileType; width?: number; height?: number; expectedSourceId?: string | null; asCopy: boolean; hasChanges: boolean };
type PendingDrawing = { imageId: string; sourceId: string | null; result?: DrawingResult; copyId?: string; anchorId?: string };
type AnswerOwner = { readOnly?: boolean; moduleId: string; attemptId: string; revisionId: string; leafPartId: string; answer?: Bank["answers"][string]; flushDurable: () => Promise<void> };
const ANSWER_ACTIONS = ["Text", "Table", "Bullet list", "Numbered list", "Code block", "Mermaid diagram", "Quote", "Drawing", "Foldable block", "Image", "Inline math", "Math block", "Add row above", "Add row below", "Add column left", "Add column right", "Delete row", "Delete column", "Toggle header row", "Delete table"];
function AnswerEditor({ doc, label, flush, owner, autoFocus, placeholder }: { doc: Y.Doc; label: string; flush: () => void; owner: AnswerOwner; autoFocus?: boolean; placeholder?: string }) {
  const storageKey = `worksheet-inline-drawing:${JSON.stringify([owner.moduleId, owner.attemptId, owner.revisionId, owner.leafPartId])}`;
  const [pending, setPending] = useState<PendingDrawing | null>(() => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) || "null"); return value && typeof value.imageId === "string" && (value.sourceId === null || typeof value.sourceId === "string") ? value : null; } catch { return null; }
  });
  const pendingRef = useRef(pending);
  const [drawingError, setDrawingError] = useState("");
  const busy = useRef(false);
  const lastFocusedEditor = useRef<import("@tiptap/core").Editor | null>(null);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [files, setFiles] = useState<ReadonlyMap<string, FileType>>(new Map());
  const retain = (value: PendingDrawing) => { pendingRef.current = value; setPending(value); localStorage.setItem(storageKey, JSON.stringify(value)); };
  const clear = () => { pendingRef.current = null; setPending(null); setDrawingError(""); localStorage.removeItem(storageKey); };
  const drawingArgs = (draft: Pick<PendingDrawing, "imageId" | "sourceId">) => ({
    moduleId: owner.moduleId, attemptId: owner.attemptId, revisionId: owner.revisionId,
    leafPartId: owner.leafPartId, imageId: draft.imageId, sourceId: draft.sourceId, displayLabel: label,
  });
  const acknowledgeDrawing = (draft: PendingDrawing, discarded = false) => isNativeHost()
    ? call("worksheet_drawing_committed", { ...drawingArgs(draft), discarded,
      publishedSourceId: draft.result?.source?.id, publishedPreviewId: draft.result?.preview?.id })
    : call("drawing_committed", { moduleId: owner.moduleId, imageId: draft.imageId });
  const hasDrawing = (current: import("@tiptap/core").Editor, draft: PendingDrawing) => {
    let found = false;
    current.state.doc.descendants(node => {
      if (["image", "inlineImage"].includes(node.type.name) && node.attrs.imageId === (draft.anchorId ?? draft.imageId) && drawingReference(node.attrs.drawing)) found = true;
    });
    return found;
  };
  const forgetDeletedDrawing = (draft: PendingDrawing) => {
    clear();
    // Use the native checkpoint cleanup also used after a successful publish.
    // A failed cleanup must never offer a deliberately removed image again.
    void acknowledgeDrawing(draft, true).catch(() => {});
  };
  const saveImage = async (file: File, permit?: WritePermit): Promise<FileType> => {
    assertWritable(permit);
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    assertWritable(permit);
    const saved = await call<FileType>("save_file", { moduleId: owner.moduleId, bytes, mimeType: file.type });
    setFiles(current => new Map(current).set(saved.id, saved));
    return saved;
  };
  const insertImages = (current: import("@tiptap/core").Editor, images: File[], position: number) => {
    void writeOperation(async permit => {
      const saved = await Promise.all(images.map(file => saveImage(file, permit)));
      assertWritable(permit);
      if (current.isDestroyed || !current.isEditable) throw new Error("The answer was closed before images could be inserted.");
      current.commands.insertContentAt(position, saved.map(file => ({ type: "image", attrs: { fileId: file.id, imageId: crypto.randomUUID() } })));
    }).catch(cause => setDrawingError(String(cause)));
  };
  const publishDrawing = async (current: import("@tiptap/core").Editor, draft: PendingDrawing) => {
    const result = draft.result!;
    if (!result.source || !result.preview) throw new Error("The drawing save was incomplete. Reopen the local draft.");
    if (current.isDestroyed || !current.isEditable) throw new Error("Reopen this answer to save its drawing draft.");
    if (!hasDrawing(current, draft)) { forgetDeletedDrawing(draft); return; }
    const imageId = draft.copyId ?? draft.imageId;
    if (draft.copyId && draft.anchorId !== imageId) {
      beginDrawing(current, imageId);
      draft = { ...draft, anchorId: imageId };
      retain(draft);
    }
    commitDrawing(current, { imageId, sourceId: result.source.id, previewId: result.preview.id, expectedSourceId: draft.copyId ? null : result.expectedSourceId ?? null });
    if (isNativeHost()) {
      // Reuse the existing image attribute understood by desktop and iOS.
      current.state.doc.descendants((node, position) => {
        if (node.type.name === "image" && node.attrs.imageId === imageId) {
          const attrs = { ...node.attrs, adaptive: true, width: node.attrs.width, height: node.attrs.height };
          if (result.width && result.height) {
            attrs.width = Math.round(node.attrs.width ?? result.width);
            attrs.height = Math.round(attrs.width * result.height / result.width);
          }
          current.view.dispatch(current.state.tr.setNodeMarkup(position, undefined, attrs));
          return false;
        }
      });
    }
    setFiles(previous => new Map(previous).set(result.source!.id, result.source!).set(result.preview!.id, result.preview!));
    await owner.flushDurable();
    await acknowledgeDrawing(draft);
    clear();
  };
  // Registered once per editor; always calls the latest runDrawing closure.
  const runDrawingRef = useRef<(current: import("@tiptap/core").Editor) => Promise<void>>(async () => {});
  const runDrawing = async (current: import("@tiptap/core").Editor, target?: PendingDrawing, retry = false, append = false) => {
    if (busy.current || current.isDestroyed || !current.isEditable) return;
    if (pendingRef.current && pendingRef.current.imageId !== target?.imageId) {
      setDrawingError("Save or reopen the retained local drawing before opening another drawing."); return;
    }
    const retainedBeforeOpen = pendingRef.current !== null;
    busy.current = true; setDrawingBusy(true); setDrawingError("");
    try {
      await writeOperation(async permit => {
        assertWritable(permit);
        if (retry && target?.result) { await publishDrawing(current, target); return; }
        const draft: PendingDrawing = target ? { ...target } : { imageId: crypto.randomUUID(), sourceId: null };
        if (target) current.state.doc.descendants(node => {
          if (node.attrs.imageId === (draft.anchorId ?? draft.imageId)) {
            const saved = drawingReference(node.attrs.drawing);
            if (saved) draft.sourceId = saved.sourceId;
          }
        });
        if (target && !hasDrawing(current, draft)) { forgetDeletedDrawing(draft); return; }
        if (!target) beginDrawing(current, draft.imageId, append ? current.state.doc.content.size : undefined);
        retain(pendingRef.current?.imageId === draft.imageId ? { ...pendingRef.current, ...draft } : draft);
        await owner.flushDurable();
        if (isNativeHost()) {
          // Anchor the real question before the shell gives its lower half to
          // PencilKit. The answer editor stays mounted and owns publication.
          current.commands.blur();
          current.view.dom.closest("section")?.scrollIntoView({ block: "start", behavior: "instant" });
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        const result = await call<DrawingResult>(isNativeHost() ? "worksheet_drawing_open" : "edit_drawing", drawingArgs(draft));
        assertWritable(permit);
        if (!current.isDestroyed && !hasDrawing(current, draft)) { forgetDeletedDrawing(draft); return; }
        if (result.status === "save") {
          const updated = { ...draft, result, copyId: result.asCopy ? crypto.randomUUID() : undefined };
          retain(updated);
          await publishDrawing(current, updated);
        } else if (["empty", "discarded", "unchanged"].includes(result.status) || result.status === "cancel" && !result.hasChanges) {
          if (!current.isDestroyed) { discardEmptyDrawing(current, draft.imageId); await owner.flushDurable(); }
          clear();
        } else if (result.status === "active" && !retainedBeforeOpen) {
          if (!target) { discardEmptyDrawing(current, draft.imageId); await owner.flushDurable(); }
          clear();
        }
      });
    } catch (cause) {
      if (pendingRef.current) setDrawingError(`${String(cause)} Your local drawing draft is retained.`);
    }
    finally { busy.current = false; setDrawingBusy(false); }
  };
  const editor = useEditor({
    editable: !owner.readOnly,
    autofocus: autoFocus && !owner.readOnly ? "end" : false,
    extensions: noteExtensions({ document: doc, reduced: true, fragment: doc.getXmlFragment("default"), insertImages, ui: {
      savedImage: SavedImage, inlineImage: InlineImage,
      inlineMath: InlineMathView, mathBlock: MathBlockView, mermaidView: MermaidView, menus: [LatexSuggest, SlashCommand.configure({ insertImages, nativeDrawing: isNativeHost(), insertDrawing: current => { void runDrawing(current); }, allowedActions: ANSWER_ACTIONS, flashcards: false })],
    } }),
    editorProps: { attributes: state => ({
      class: "tiptap worksheet-answer-input",
      "aria-label": `Your answer for question ${label}`,
      "data-answer-empty": String(state.doc.childCount === 1 && state.doc.firstChild?.type.name === "paragraph" && state.doc.firstChild.content.size === 0),
      "data-placeholder": placeholder ?? "Type your answer here, or type /drawing to insert a drawing.",
      autocapitalize: "off", autocorrect: "off",
    }) },
    onFocus: ({ editor }) => { lastFocusedEditor.current = editor; },
    onBlur: flush,
  }, [doc]);
  useEffect(() => {
    const anchor = () => {
      if (!busy.current || !editor || editor.isDestroyed) return;
      requestAnimationFrame(() => editor.view.dom.closest("section")?.scrollIntoView({ block: "start", behavior: "instant" }));
    };
    window.addEventListener("worksheet-drawer-resized", anchor);
    return () => window.removeEventListener("worksheet-drawer-resized", anchor);
  }, [editor]);
  runDrawingRef.current = current => runDrawing(current);
  useEffect(() => editor && !owner.readOnly ? registerWorksheetEditor(editor, owner.moduleId, storageKey, capabilities.worksheetDrawing ? () => { void runDrawingRef.current(editor); } : undefined) : undefined, [editor, owner.moduleId, owner.readOnly]);
  const inlineSources = useEditorState({ editor, selector: ({ editor }) => {
    const ids: string[] = [];
    editor.state.doc.descendants(node => { const drawing = drawingReference(node.attrs.drawing); if (drawing?.sourceId) ids.push(drawing.sourceId); });
    return ids;
  } }) ?? [];
  useEffect(() => {
    if (!editor) return;
    const reconcile = () => {
      const draft = pendingRef.current;
      if (draft && !editor.isDestroyed && !isSchemaReadOnly(editor) && !hasDrawing(editor, draft)) forgetDeletedDrawing(draft);
    };
    // The shared image menu, keyboard deletion and range deletion all arrive
    // here as document updates. Never recreate a missing recovery placeholder.
    reconcile();
    editor.on("update", reconcile);
    return () => { editor.off("update", reconcile); };
  }, [editor]);
  const blocked = useEditorState({ editor, selector: ({ editor }) => isSchemaReadOnly(editor) }) ?? false;
  useEffect(() => watchWriteAdmission(admissionBlocked => {
    if (editor && !editor.isDestroyed) editor.setEditable(!owner.readOnly && !admissionBlocked && !isSchemaReadOnly(editor), false);
  }), [editor, owner.readOnly]);
  const [recoverable, setRecoverable] = useState(false);
  useEffect(() => {
    if (owner.readOnly || !isNativeHost() || !pending || drawingBusy || !editor) return;
    // A publication receipt remains recoverable until durable save and native acknowledgement.
    if (pending.result) { setRecoverable(true); return; }
    let cancelled = false;
    setRecoverable(false);
    let sourceId = pending.sourceId;
    editor.state.doc.descendants(node => {
      if (node.attrs.imageId === (pending.anchorId ?? pending.imageId)) sourceId = drawingReference(node.attrs.drawing)?.sourceId ?? sourceId;
    });
    void call<boolean>("worksheet_drawing_has_draft", { ...drawingArgs(pending), sourceId }).then(hasDraft => {
      if (cancelled) return;
      setRecoverable(hasDraft);
      if (!hasDraft) clear();
    }).catch(() => { /* Retain recovery metadata until native storage can be checked. */ });
    return () => { cancelled = true; };
  }, [pending, drawingBusy, editor]);
  return <div data-worksheet-answer={JSON.stringify([owner.moduleId, owner.attemptId, owner.revisionId, owner.leafPartId])}>
    {blocked && <p role="alert">This answer contains content from a newer app version. Update the app to edit it; the original is retained.</p>}
    <div hidden={blocked}>
      <FilesContext.Provider value={{ moduleId: owner.moduleId, files, flashcards: false, saveImage,
        readImage: async fileId => { const read = await call<{ bytes: number[]; file_type: string }>("read_file", { moduleId: owner.moduleId, fileId }); return new Blob([new Uint8Array(read.bytes)], { type: read.file_type }); },
        editDrawing: !owner.readOnly && capabilities.worksheetDrawing ? (imageId, sourceId) => { if (editor) void runDrawing(editor, { imageId, sourceId }); } : undefined,
        unsavedDrawingId: pending && !drawingBusy && (!isNativeHost() || recoverable) ? pending.anchorId ?? pending.imageId : null }}>
        <div className="worksheet-answer-field">
          <EditorContent editor={editor} />
          {!owner.readOnly && isNativeHost() && <Button
            type="button"
            size="icon"
            variant="ghost"
            className="worksheet-drawing-shortcut text-muted-foreground"
            aria-label="Insert drawing"
            disabled={!editor || drawingBusy || !!pending}
            onPointerDown={event => event.preventDefault()}
            onClick={() => {
              if (!editor) return;
              const activeAnswer = editor.view.dom.ownerDocument.activeElement;
              if (activeAnswer instanceof HTMLElement && activeAnswer !== editor.view.dom && activeAnswer.matches(".worksheet-answer-input")) {
                activeAnswer.blur();
              }
              void runDrawing(editor, undefined, false, lastFocusedEditor.current !== editor);
            }}
          ><Pencil aria-hidden="true" /></Button>}
        </div>
      </FilesContext.Provider>
      {/* As in notes: on iPad the native bar above the keyboard formats, so no web bubble. */}
      {!owner.readOnly && !isNativeHost() && <>
        <TextBubbleMenu editor={editor} flashcards={false} />
        <LinkMenu editor={editor} />
      </>}
      {/* On iPad, opening the drawing again resumes its unsaved draft (unless a newer save replaced it),
          so no resume row appears and shifts the page; only a failed save offers a retry. */}
      {!owner.readOnly && pending && (!isNativeHost() || (recoverable && pending.result)) && !drawingBusy && capabilities.worksheetDrawing && <div className="flex gap-1">
        {pending.result && <Button size="sm" variant="ghost" onClick={() => { if (editor) void runDrawing(editor, pending, true); }}>Retry drawing save</Button>}
        {!isNativeHost() && <Button size="sm" variant="ghost" onClick={() => { if (editor) void runDrawing(editor, { ...pending, result: undefined, copyId: undefined }); }}>Reopen local drawing</Button>}
      </div>}
      {drawingError && <p role="alert" className="text-sm text-destructive">{drawingError}</p>}
      <WorksheetDrawings {...owner} inlineSources={inlineSources} />
    </div>
  </div>;
}
export function answerHasContent(fragment: Y.XmlFragment): boolean {
  return fragment.toArray().some(node => node instanceof Y.XmlText ? node.toDelta().some((delta: { insert?: unknown }) => typeof delta.insert === "string" && delta.insert.trim().length > 0)
    : node instanceof Y.XmlElement && (["image", "inlineImage", "horizontalRule", "mention", "pdfTextQuote"].includes(node.nodeName) || answerHasContent(node)));
}
export function WorksheetAnswerEditor({ label, load, save, flush, autoFocus, placeholder, ...owner }: AnswerOwner & {
  label: string;
  autoFocus?: boolean;
  placeholder?: string;
  load: () => Promise<AnswerDocument & { legacyDraft?: string }>;
  save: (document: number[], expected: string, text: string, hasContent: boolean) => void;
  flush: () => void;
}) {
  const callbacks = useRef({ load, save, flush });
  callbacks.current = { load, save, flush };
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let document: Y.Doc | undefined;
    let changed: (() => void) | undefined;
    setError("");
    void callbacks.current.load().then(loaded => {
      if (!active) return;
      document = new Y.Doc();
      Y.applyUpdate(document, new Uint8Array(loaded.document));
      const fragment = document.getXmlFragment("default");
      // Deliberately migrate only the backend-confirmed legacy plain shape.
      // Literal dollars/HTML/newlines remain literal text, never parsed markup.
      if (loaded.plainText !== null) {
        const text = loaded.legacyDraft ?? loaded.plainText;
        document.transact(() => {
          fragment.delete(0, fragment.length);
          const paragraph = new Y.XmlElement("paragraph");
          fragment.insert(0, [paragraph]);
          if (text) { const child = new Y.XmlText(); paragraph.insert(0, [child]); child.insert(0, text); }
        });
      }
      const current = document;
      changed = () => {
        if (owner.readOnly || isNoteFromNewerVersion(current)) return;
        callbacks.current.save(Array.from(Y.encodeStateAsUpdate(current)), loaded.expected, fragment.toString(), answerHasContent(fragment));
      };
      // Quarantine before y-tiptap gets a chance to normalize unknown content.
      if (!owner.readOnly && !isNoteFromNewerVersion(current)) {
        current.on("update", changed);
        if (loaded.plainText !== null && (loaded.legacyDraft !== undefined || loaded.plainText.length > 0)) changed();
      }
      setDoc(current);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      active = false;
      if (document && changed) document.off("update", changed);
      callbacks.current.flush();
      // TipTap owns its binding cleanup; this private doc has no external feeds.
    };
  }, [retry]);
  if (error) return <div role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry opening answer</Button></div>;
  return doc ? <AnswerEditor doc={doc} label={label} owner={owner} autoFocus={autoFocus} placeholder={placeholder} flush={() => callbacks.current.flush()} /> : <p role="status">Loading answer…</p>;
}
