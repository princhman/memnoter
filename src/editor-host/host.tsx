import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sectionFocusKey } from "@/lib/section-focus";
import { observeScroll, traceScroll, refreshSectionAnchor, revealCaret, sectionToTop } from "./scroll";
import Tiptap from "@/components/Tiptap";
import { useActiveEditor } from "@/lib/active-editor-context";
import { postNativeEvent } from "@/lib/backend";
import { queryClient } from "@/lib/query-client";
import { saveStatusStore } from "@/lib/saves";
import { imageStatusStore, exclusiveWrite } from "@/lib/write-lifecycle";
import { flushPersistedViews } from "@/lib/view-persistence";
import { editorOutline, editorState, execEditor } from "./commands";

declare global {
  interface Window {
    memnoterEditor: {
      setBottomInset(px: number): void;
      setTopInset(px: number): void;
      open(moduleId: string): Promise<void>;
      flush(): Promise<void>;
      exec(command: string, args?: Record<string, unknown>): boolean;
      focus(): boolean;
      blur(): boolean;
    };
  }
}

export function Host() {
  const [moduleId, setModuleId] = useState<string | null>(null);
  const { activeEditor } = useActiveEditor();
  const active = useRef(activeEditor);
  const container = useRef<HTMLElement>(null);
  const opening = useRef<{ moduleId: string; resolve(): void; reject(error: Error): void } | null>(null);
  useLayoutEffect(() => { active.current = activeEditor; }, [activeEditor]);

  useEffect(() => {
    const stopScroll = container.current ? observeScroll(container.current) : () => {};
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      postNativeEvent("error", { moduleId: active.current?.moduleId ?? opening.current?.moduleId ?? null, message });
      return new Error(message);
    };
    const getEditor = () => {
      const current = active.current;
      if (opening.current || !current?.isReady || current.editor.isDestroyed || !current.editor.isEditable) throw new Error("Editor is not ready");
      return current.editor;
    };
    let queue = Promise.resolve();
    window.memnoterEditor = {
      setTopInset(px) {
        traceScroll("topInset", { px });
        if (!Number.isFinite(px) || px < 0) throw new Error("Invalid top inset");
        const element = container.current;
        if (!element) return;
        element.dataset.topInset = String(px);
        element.style.setProperty("--top-inset", `${px}px`);
        refreshSectionAnchor(element);
      },
      setBottomInset(px) {
        traceScroll("bottomInset", { px });
        if (!Number.isFinite(px) || px < 0) throw new Error("Invalid bottom inset");
        const element = container.current;
        if (!element) return;
        element.dataset.bottomInset = String(px);
        element.style.setProperty("--bottom-inset", `${px}px`);
        const editor = active.current?.editor;
        if (!refreshSectionAnchor(element) && editor && !editor.isDestroyed) requestAnimationFrame(() => revealCaret(editor.view));
      },
      open(id) {
        const operation = queue.then(async () => {
          if (typeof id !== "string" || !id) throw new Error("open requires a moduleId");
          if (active.current?.moduleId === id && active.current.isReady) return;
          flushPersistedViews();
          await exclusiveWrite(async () => {});
          await new Promise<void>((resolve, reject) => {
            opening.current = { moduleId: id, resolve, reject };
            setModuleId(id);
          });
        }).catch(error => { throw fail(error); });
        queue = operation.catch(() => {});
        return operation;
      },
      async flush() {
        try { flushPersistedViews(); await exclusiveWrite(async () => {}); }
        catch (error) { throw fail(error); }
      },
      exec(command, args) {
        try { return execEditor(getEditor(), command, args); }
        catch (error) { fail(error); return false; }
      },
      focus() {
        try { return getEditor().commands.focus(); }
        catch (error) { fail(error); return false; }
      },
      blur() {
        try { return getEditor().commands.blur(); }
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
    postNativeEvent("ready", { protocolVersion: 1 });
    return () => { stopScroll(); stopErrors(); stopMutations(); stopSaves.unsubscribe(); stopImages.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!activeEditor?.isReady) return;
    const { editor, moduleId: id } = activeEditor;
    let lastOutline = "";
    const publish = () => {
      if (editor.isDestroyed) return;
      postNativeEvent("state", { moduleId: id, ...editorState(editor) });
      const headings = editorOutline(editor);
      const encoded = JSON.stringify(headings);
      if (encoded !== lastOutline) {
        lastOutline = encoded;
        postNativeEvent("outline", { moduleId: id, headings });
      }
    };
    publish();
    const focused = sectionFocusKey.getState(editor.state);
    if (focused != null) {
      sectionToTop(editor, focused);
      requestAnimationFrame(() => revealCaret(editor.view));
    }
    if (opening.current?.moduleId === id) {
      opening.current.resolve();
      opening.current = null;
    }
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => revealCaret(editor.view));
    };
    editor.on("transaction", publish);
    editor.on("selectionUpdate", reveal);
    editor.on("update", reveal);
    editor.on("focus", reveal);
    window.addEventListener("resize", reveal);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", publish);
      editor.off("selectionUpdate", reveal);
      editor.off("update", reveal);
      editor.off("focus", reveal);
      window.removeEventListener("resize", reveal);
    };
  }, [activeEditor]);

  return <main ref={container} className="app-scroll-container h-full overflow-y-auto p-4">{moduleId && <Tiptap key={moduleId} moduleId={moduleId} hostOnly />}</main>;
}
