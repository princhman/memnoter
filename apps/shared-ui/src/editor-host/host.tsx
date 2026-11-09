import { editorHost } from "@/lib/editor-host";
import { settled } from "@/lib/async-work";
import { EditorHostProvider } from "@/lib/editor-host-context";
import { BRIDGE_VERSION, EXEC_COMMANDS } from "./protocol";
import { onRemote, onFileStored } from "@/lib/sync/apply-remote";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { requestCardReveal } from "@/lib/card-reveal";
import { blockIdOf } from "@/lib/cards";
import { sectionFocusKey } from "@/lib/section-focus";
import { observeCardInfo } from "./card-info";
import { observeScroll, traceScroll, hasSectionAnchor, revealCaret, sectionToTop } from "./scroll";
import Tiptap from "@/components/Tiptap";
import { useActiveEditor } from "@/lib/active-editor-context";
import { postNativeEvent } from "@/lib/backend";
import { queryClient } from "@/lib/query-client";
import { saveStatusStore } from "@/lib/saves";
import { imageStatusStore, flushAll } from "@/lib/write-lifecycle";
import { flushPersistedViews } from "@/lib/view-persistence";
import { headingMathLabel } from "@/lib/heading-label";
import { headingNumbers, headingNumberingKey } from "@/lib/heading-numbering";
import { editorOutline, editorOutlines, editorState, execEditor } from "./commands";

// How long after typing the caret may not be revealed upward.
const TYPING_SETTLE_MS = 300;

export function Host() {
  const [moduleId, setModuleId] = useState<string | null>(null);
  const { activeEditor } = useActiveEditor();
  const active = useRef(activeEditor);
  const container = useRef<HTMLElement>(null);
  const outlineTracking = useRef(false);
  const refreshOutline = useRef(() => {});
  const opening = useRef<{ moduleId: string; resolve(): void; reject(error: Error): void } | null>(null);
  useLayoutEffect(() => { active.current = activeEditor; }, [activeEditor]);

  useEffect(() => {
    const stopCardInfo = container.current ? observeCardInfo(container.current) : () => {};
    const stopScroll = container.current ? observeScroll(container.current) : () => {};
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      postNativeEvent("error", { moduleId: active.current?.moduleId ?? opening.current?.moduleId ?? null, message });
      return new Error(message);
    };
    const getEditor = (readOnly = false) => {
      const current = active.current;
      if (opening.current || !current?.isReady || current.editor.isDestroyed || (!readOnly && !current.editor.isEditable)) throw new Error("Editor is not ready");
      return current.editor;
    };
    let queue = Promise.resolve();
    window.memnoterEditor = {
      setOutlineTracking(enabled) { outlineTracking.current = enabled; refreshOutline.current(); },
      async refreshModules() { await queryClient.invalidateQueries({ queryKey: ["modules"] }); },
      applyRemote: onRemote,
      fileStored: onFileStored,
      setTopInset(px) {
        traceScroll("topInset", { px });
        if (!Number.isFinite(px) || px < 0) throw new Error("Invalid top inset");
        const element = container.current;
        if (!element || element.dataset.topInset === String(px)) return;
        element.dataset.topInset = String(px);
        element.style.setProperty("--top-inset", `${px}px`);
      },
      setBottomInset(px) {
        traceScroll("bottomInset", { px });
        if (!Number.isFinite(px) || px < 0) throw new Error("Invalid bottom inset");
        const element = container.current;
        if (!element || element.dataset.bottomInset === String(px)) return;
        element.dataset.bottomInset = String(px);
        element.style.setProperty("--bottom-inset", `${px}px`);
        const editor = active.current?.editor;
        if (!hasSectionAnchor(element) && editor && !editor.isDestroyed) requestAnimationFrame(() => { if (!editor.isDestroyed) revealCaret(editor.view, "inset"); });
      },
      open(id) {
        const operation = queue.then(async () => {
          if (typeof id !== "string" || !id) throw new Error("open requires a moduleId");
          if (active.current?.moduleId === id && active.current.isReady) return;
          flushPersistedViews();
          await flushAll();
          await new Promise<void>((resolve, reject) => {
            opening.current = { moduleId: id, resolve, reject };
            setModuleId(id);
          });
        }).catch(error => { throw fail(error); });
        queue = settled(operation);
        return operation;
      },
      async flush() {
        try { flushPersistedViews(); await flushAll(); }
        catch (error) { throw fail(error); }
      },
      exec(command, args) {
        try { return execEditor(getEditor(EXEC_COMMANDS[command] === true), command, args); }
        catch (error) { fail(error); return false; }
      },
      revealCard(moduleId, cardId) { requestCardReveal({ moduleId, blockId: blockIdOf(cardId) }); },
      focus() {
        try { return getEditor().commands.focus(); }
        catch (error) { fail(error); return false; }
      },
    };
    const stopErrors = queryClient.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      const error = event.query.state.error;
      const pending = opening.current;
      if (pending && event.query.queryKey[0] === "content" && event.query.queryKey[1] === pending.moduleId) {
        opening.current = null;
        setModuleId(null);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      } else fail(error);
    });
    const stopMutations = queryClient.getMutationCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "error") fail(event.mutation.state.error);
    });
    const saveStatus = () => postNativeEvent("saveStatus", { ...saveStatusStore.state, imageErrors: imageStatusStore.state.errors });
    const stopSaves = saveStatusStore.subscribe(saveStatus);
    const stopImages = imageStatusStore.subscribe(saveStatus);
    saveStatus();
    postNativeEvent("ready", { protocolVersion: BRIDGE_VERSION });
    return () => { stopCardInfo(); stopScroll(); stopErrors(); stopMutations(); stopSaves.unsubscribe(); stopImages.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!activeEditor?.isReady) return;
    const { editor, moduleId: id } = activeEditor;
    let lastOutline = "";
    let lastCurrent: string | null | undefined;
    const publishCurrent = () => {
      if (!outlineTracking.current || editor.isDestroyed) return;
      const headings = editorOutline(editor);
      const top = (container.current?.getBoundingClientRect().top ?? 0) + Number(container.current?.dataset.topInset ?? 0) + 24;
      const currentHeadingId = [...headings].reverse().find(item => {
        const node = editor.view.nodeDOM(item.pos);
        return node instanceof HTMLElement && node.getBoundingClientRect().top <= top;
      })?.id ?? headings[0]?.id ?? null;
      if (currentHeadingId !== lastCurrent) {
        lastCurrent = currentHeadingId;
        postNativeEvent("outlineCurrent", { moduleId: id, currentHeadingId });
      }
    };
    refreshOutline.current = publishCurrent;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (!outlineTracking.current || scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = undefined; publishCurrent(); }, 120);
    };
    container.current?.addEventListener("scroll", onScroll, { passive: true });
    const publish = () => {
      if (editor.isDestroyed) return;
      postNativeEvent("state", { moduleId: id, ...editorState(editor) });
      const numbers = headingNumberingKey.getState(editor.state) ? headingNumbers(editor.state.doc) : new Map<number, string>();
      const formatHeading = (item: ReturnType<typeof editorOutline>[number]) => {
        let text = "";
        editor.state.doc.nodeAt(item.pos)?.forEach(child => { text += child.type.name === "inlineMath" ? headingMathLabel(child.textContent) : child.textContent; });
        return { ...item, text, number: numbers.get(item.pos) ?? null };
      };
      const outline = editorOutlines(editor);
      const headings = outline.headings.map(formatHeading);
      const allHeadings = outline.allHeadings.map(formatHeading);
      const encoded = JSON.stringify({ headings, allHeadings });
      if (encoded !== lastOutline) {
        lastOutline = encoded;
        postNativeEvent("outline", { moduleId: id, headings, allHeadings });
      }
      publishCurrent();
    };
    publish();
    const focused = sectionFocusKey.getState(editor.state);
    if (focused != null) {
      sectionToTop(editor, focused);
    }
    if (opening.current?.moduleId === id) {
      opening.current.resolve();
      opening.current = null;
    }
    let frame = 0;
    let inputScroll: number | undefined;
    let lastInput = Number.NEGATIVE_INFINITY;
    const element = container.current;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        // WebKit may reveal the selection during input even when ProseMirror's
        // scrolling is handled. Apply our visibility rule from the reader's
        // pre-input position, rather than from WebKit's unsolicited scroll.
        if (element && inputScroll !== undefined) element.scrollTop = inputScroll;
        inputScroll = undefined;
        // Selection, update and focus events can trail the input by several
        // frames, while WebKit's layout is still settling.
        revealCaret(editor.view, performance.now() - lastInput < TYPING_SETTLE_MS ? "input" : "selection");
      });
    };
    const beforeInput = (event: Event) => {
      // Undo and redo jump to wherever the change was, so they may need to scroll.
      const history = event instanceof InputEvent && event.inputType.startsWith("history");
      if (!history) {
        lastInput = performance.now();
        if (element && inputScroll === undefined) inputScroll = element.scrollTop;
      }
      reveal();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Enter") beforeInput(event); };
    element?.addEventListener("beforeinput", beforeInput, true);
    element?.addEventListener("keydown", keydown, true);
    editor.on("transaction", publish);
    editor.on("selectionUpdate", reveal);
    editor.on("update", reveal);
    editor.on("focus", reveal);
    return () => {
      element?.removeEventListener("beforeinput", beforeInput, true);
      element?.removeEventListener("keydown", keydown, true);
      clearTimeout(scrollTimer);
      container.current?.removeEventListener("scroll", onScroll);
      refreshOutline.current = () => {};
      cancelAnimationFrame(frame);
      editor.off("transaction", publish);
      editor.off("selectionUpdate", reveal);
      editor.off("update", reveal);
      editor.off("focus", reveal);
    };
  }, [activeEditor]);

  return <EditorHostProvider value={editorHost}><main ref={container} className="app-scroll-container h-full overflow-y-auto p-4">{moduleId && <Tiptap key={moduleId} moduleId={moduleId} />}</main></EditorHostProvider>;
}
