import { worksheetEditor } from "./worksheet-editor";
import { pdfSelectionControls } from "@/lib/pdf-selection-controls";
import { beginHostNavigation, editorHost } from "@/lib/editor-host";
import { settled } from "@/lib/async-work";
import { EditorHostProvider } from "@/lib/editor-host-context";
import { pdfAnnotationSaveStatusStore } from "@/lib/pdf-annotation-store";
import { BRIDGE_VERSION, EXEC_COMMANDS } from "./protocol";
import { onRemote, onFileStored } from "@/lib/sync/apply-remote";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { requestCardReveal } from "@/lib/card-reveal";
import { sectionFocusKey } from "@/lib/section-focus";
import { observeCardInfo } from "./card-info";
import { observeScroll, traceScroll, hasSectionAnchor, revealCaret, sectionToTop } from "./scroll";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { NativePdfWorkspace, type NativePdfActions } from "./pdf-workspace";
import Tiptap from "@/components/Tiptap";
import { QuestionBank } from "@/components/question-bank";
import { useBankGate } from "@/lib/question-bank";
import { useModules } from "@/lib/modules";
import { updatePdfPane, useAnyWorksheetOpen } from "@/lib/pdf-pane";
import SaveStatus from "@/components/save-status";
import { useActiveEditor } from "@/lib/active-editor-context";
import { postNativeEvent } from "@/lib/backend";
import { queryClient } from "@/lib/query-client";
import { saveStatusStore } from "@/lib/saves";
import { imageStatusStore, flushAll } from "@/lib/write-lifecycle";
import { flushPersistedViews } from "@/lib/view-persistence";
import { headingMathLabel } from "@/lib/heading-label";
import { headingNumbers, headingNumberingKey } from "@/lib/heading-numbering";
import { editorOutline, editorOutlines, editorState, execEditor } from "./commands";

async function flushHostWrites() {
  flushPersistedViews();
  await flushAll({ navigation: true });
}

// Use the desktop /questions data source and components without its app shell.
// QuestionBank owns the worksheet picker and renders WorksheetAttempt itself.
function NativeQuestions({ scope, onOpenSource, visible, tablet, worksheetModule }: { scope: string | null; onOpenSource(documentId: string): void; visible: boolean; tablet: boolean; worksheetModule: string | null }) {
  const enabled = useBankGate();
  const { data: modules = [], isPending, error } = useModules();
  if (!enabled) return <p className="text-center text-sm text-muted-foreground">Questions are not available.</p>;
  const selectedModule = scope ?? worksheetModule;
  const scopedModules = modules.filter(module => !selectedModule || module.id === selectedModule);
  return <div className="questions-all mx-auto w-full max-w-3xl space-y-8 py-4">
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
    {!isPending && !error && !scopedModules.length && <p className="text-sm text-muted-foreground">{scope ? "Module not found." : "Create a module to start collecting questions."}</p>}
    {tablet && !selectedModule && !isPending && !error && scopedModules.length > 0 && <p className="questions-all-empty text-sm text-muted-foreground">Open a PDF and choose <span className="text-foreground">Crop question</span> to add questions.</p>}
    {scopedModules.map(module => <section key={module.id} className="questions-module" aria-label={module.name || "Untitled module"}>
      {!selectedModule && <h2 className="bank-module-heading mb-4 text-sm font-medium text-muted-foreground">{module.name || "Untitled module"}</h2>}
      <QuestionBank moduleId={module.id} onOpenSource={onOpenSource} hideWhenEmpty={tablet && !scope} nativeToolbar={visible && !!scope && tablet} />
    </section>)}
  </div>;
}

export function Host() {
  const router = useRouter();
  const requestedModule = useRouterState({ select: state => {
    const match = state.matches.find(match => "moduleId" in match.params);
    return match && "moduleId" in match.params ? match.params.moduleId : null;
  } });
  const pdfActions = useRef<NativePdfActions>(null);
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<{ open: boolean; moduleId: string | null; mounted: boolean }>({ open: false, moduleId: null, mounted: false });
  const [questionSourceOpen, setQuestionSourceOpen] = useState<string | null>(null);
  const tablet = document.documentElement.classList.contains("native-tablet");
  const openWorksheetModule = useAnyWorksheetOpen();
  const worksheetModule = tablet && (!questions.moduleId || questions.moduleId === openWorksheetModule) ? openWorksheetModule : null;
  const questionSurface = useRef(questions);
  const showQuestions = (open: boolean, scope: string | null = questionSurface.current.moduleId) => {
    if (!open || scope !== questionSurface.current.moduleId) setQuestionSourceOpen(null);
    const next = { open, moduleId: scope, mounted: questionSurface.current.mounted || open };
    questionSurface.current = next;
    setQuestions(next);
    postNativeEvent("questionBankState", { open, moduleId: scope });
  };
  const { activeEditor } = useActiveEditor();
  const active = useRef(activeEditor);
  const container = useRef<HTMLElement>(null);
  const outlineTracking = useRef(false);
  const refreshOutline = useRef(() => {});
  const opening = useRef<{ moduleId: string; resolve(): void; reject(error: Error): void } | null>(null);
  useLayoutEffect(() => { active.current = activeEditor; }, [activeEditor]);

  useEffect(() => {
    if (requestedModule && requestedModule !== moduleId && !opening.current) postNativeEvent("openModule", { moduleId: requestedModule });
  }, [requestedModule, moduleId]);

  useEffect(() => {
    const stopCardInfo = container.current ? observeCardInfo(container.current) : () => {};
    const stopScroll = container.current ? observeScroll(container.current) : () => {};
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      postNativeEvent("error", { moduleId: active.current?.moduleId ?? opening.current?.moduleId ?? null, message });
      return new Error(message);
    };
    const getEditor = (readOnly = false) => {
      if (questionSurface.current.open) {
        const answer = worksheetEditor();
        if (!answer || (!readOnly && !answer.isEditable)) throw new Error("Select an answer to edit it.");
        return answer;
      }
      const current = active.current;
      if (questionSurface.current.open || opening.current || !current?.isReady || current.editor.isDestroyed || (!readOnly && !current.editor.isEditable)) throw new Error("Editor is not ready");
      return current.editor;
    };
    let queue = Promise.resolve();
    window.memnoterEditor = {
      toggleFiles() { if (!questionSurface.current.open) getEditor(true); pdfActions.current?.toggleFiles(); },
      async refreshDocuments(id) { await pdfActions.current?.refreshDocuments(id); },
      pdfSelectionAction(action, color) { pdfSelectionControls.run(action, color); },
      pdfCommand(command, value) { pdfActions.current?.pdfCommand(command, value); },
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
        element.parentElement?.style.setProperty("--top-inset", `${px}px`);
        const editor = active.current?.editor;
        if (!hasSectionAnchor(element) && editor && !editor.isDestroyed) revealCaret(editor.view, "inset");
      },
      setBottomInset(px) {
        traceScroll("bottomInset", { px });
        if (!Number.isFinite(px) || px < 0) throw new Error("Invalid bottom inset");
        const element = container.current;
        if (!element || element.dataset.bottomInset === String(px)) return;
        element.dataset.bottomInset = String(px);
        element.style.setProperty("--bottom-inset", `${px}px`);
        element.parentElement?.style.setProperty("--bottom-inset", `${px}px`);
        document.documentElement.style.setProperty("--native-bottom-inset", `${px}px`);
        const editor = active.current?.editor;
        if (!hasSectionAnchor(element) && editor && !editor.isDestroyed) revealCaret(editor.view, "inset");
      },
      open(id) {
        traceScroll("open-entered", { moduleId: id });
        const operation = queue.then(async () => {
          if (typeof id !== "string" || !id) throw new Error("open requires a moduleId");
          traceScroll("open-queue-start", { moduleId: id });
          await flushHostWrites();
          traceScroll("open-flushed", { moduleId: id });
          showQuestions(false);
          if (active.current?.moduleId === id && active.current.isReady) {
            await router.navigate({ to: "/$moduleId", params: { moduleId: id } });
            traceScroll("open-route-complete", { moduleId: id });
            return;
          }
          await new Promise<void>((resolve, reject) => {
            opening.current = { moduleId: id, resolve, reject };
            setModuleId(id);
            void router.navigate({ to: "/$moduleId", params: { moduleId: id } })
              .then(() => traceScroll("open-route-complete", { moduleId: id })).catch(reject);
          });
        }).catch(error => { throw fail(error); });
        queue = settled(operation);
        return operation;
      },
      openQuestions(scope) {
        const operation = queue.then(async () => {
          if (scope !== null && (typeof scope !== "string" || !scope)) throw new Error("openQuestions requires a moduleId or null");
          await flushHostWrites();
          active.current?.editor.view.dom.blur();
          const id = active.current?.moduleId;
          if (id) updatePdfPane(id, { open: false });
          await router.navigate({ to: "/" });
          showQuestions(true, scope);
        }).catch(error => { throw fail(error); });
        queue = settled(operation);
        return operation;
      },
      closeQuestions() {
        const operation = queue.then(async () => {
          await flushHostWrites();
          showQuestions(false);
          const id = active.current?.moduleId;
          if (id) await router.navigate({ to: "/$moduleId", params: { moduleId: id } });
          else await router.navigate({ to: "/" });
        }).catch(error => { throw fail(error); });
        queue = settled(operation);
        return operation;
      },
      async flush() {
        try { await flushHostWrites(); }
        catch (error) { throw fail(error); }
      },
      exec(command, args) {
        try {
          const editor = getEditor(EXEC_COMMANDS[command] === true);
          const focusedSection = sectionFocusKey.getState(editor.state);
          const result = execEditor(editor, command, args);
          // Persist focus changes before returning from the native command.
          // The app can quit before the debounced view save runs.
          if (sectionFocusKey.getState(editor.state) !== focusedSection) flushPersistedViews();
          if (result && command === "insertImage") {
            const element = editorHost.scrollContainer(editor.view.dom);
            if (element) beginHostNavigation(element);
            requestAnimationFrame(() => revealCaret(editor.view, "insertion"));
          }
          return result;
        }
        catch (error) { fail(error); return false; }
      },
      revealCard(moduleId, cardId) { requestCardReveal({ moduleId, cardId }); },
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
    const saveStatus = () => postNativeEvent("saveStatus", {
      pending: saveStatusStore.state.pending + pdfAnnotationSaveStatusStore.state.pending,
      failing: saveStatusStore.state.failing || pdfAnnotationSaveStatusStore.state.failing,
      imageErrors: imageStatusStore.state.errors,
    });
    const stopSaves = saveStatusStore.subscribe(saveStatus);
    const stopImages = imageStatusStore.subscribe(saveStatus);
    const stopAnnotations = pdfAnnotationSaveStatusStore.subscribe(saveStatus);
    saveStatus();
    postNativeEvent("questionBankState", { open: false, moduleId: null });
    postNativeEvent("ready", { protocolVersion: BRIDGE_VERSION });
    return () => { stopCardInfo(); stopScroll(); stopErrors(); stopMutations(); stopSaves.unsubscribe(); stopImages.unsubscribe(); stopAnnotations.unsubscribe(); };
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
      if (!questionSurface.current.open) postNativeEvent("state", { moduleId: id, ...editorState(editor) });
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
      traceScroll("open-editor-ready", { moduleId: id });
      opening.current.resolve();
      opening.current = null;
    }
    let frame = 0;
    let inputScroll: number | undefined;
    const element = container.current;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        revealCaret(editor.view, inputScroll === undefined ? "selection" : "input", inputScroll);
        inputScroll = undefined;
      });
    };
    const beforeInput = (event: Event) => {
      // Undo and redo jump to wherever the change was, so they may need to scroll.
      const history = event instanceof InputEvent && event.inputType.startsWith("history");
      if (!history) {
        if (element && inputScroll === undefined) inputScroll = element.scrollTop;
      }
      reveal();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Enter") beforeInput(event); };
    let pointerSelecting = false;
    let selectionPending = false;
    const selecting = () => {
      pointerSelecting = true;
      selectionPending = false;
      inputScroll = undefined;
    };
    const selectionChanged = () => {
      if (pointerSelecting) selectionPending = true;
      else reveal();
    };
    const selected = (event: Event) => {
      if (event instanceof PointerEvent && event.type === "pointerup" && event.pointerType === "touch") return;
      const wasSelecting = pointerSelecting;
      pointerSelecting = false;
      // Retry focus/inset reveals skipped during the gesture, using only the
      // selection WebKit has now placed. Native insets still coalesce this.
      if (selectionPending || wasSelecting) reveal();
      selectionPending = false;
    };
    // A cancelled pointer usually means a scroll gesture. Do not reveal an
    // unchanged caret when the reader finishes panning through a long note.
    const cancelled = () => { pointerSelecting = false; selectionPending = false; };
    element?.addEventListener("pointerdown", selecting, true);
    // WebKit can update its selection before ProseMirror publishes a transaction.
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("pointerup", selected);
    document.addEventListener("click", selected);
    document.addEventListener("pointercancel", cancelled);
    element?.addEventListener("beforeinput", beforeInput, true);
    element?.addEventListener("keydown", keydown, true);
    // Native reports keyboard occlusion. Window resize only schedules the same
    // manager for viewport size changes, never another reveal policy.
    window.addEventListener("resize", reveal);
    editor.on("transaction", publish);
    editor.on("selectionUpdate", reveal);
    editor.on("update", reveal);
    editor.on("focus", reveal);
    return () => {
      element?.removeEventListener("pointerdown", selecting, true);
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("pointerup", selected);
      document.removeEventListener("click", selected);
      document.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("resize", reveal);
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

  const openQuestionSource = (documentId: string) => {
    if (questions.moduleId) updatePdfPane(questions.moduleId, { open: true, active: documentId });
    else setQuestionSourceOpen(documentId);
  };
  return <EditorHostProvider value={editorHost}><NativePdfWorkspace questions={questions.open} moduleId={questions.open ? questions.moduleId : moduleId} actions={pdfActions} sourceDocumentId={worksheetModule ? null : questionSourceOpen} onCloseSource={() => setQuestionSourceOpen(null)}><SaveStatus />
    <main ref={container} style={questions.open ? { display: "none" } : undefined} className="app-scroll-container h-full overflow-y-auto p-4">{moduleId && <Tiptap key={moduleId} moduleId={moduleId} />}</main>
    {questions.mounted && <main aria-label={worksheetModule ? "Worksheet" : "Questions"} style={!questions.open ? { display: "none" } : undefined} className="app-scroll-container native-questions h-full overflow-y-auto p-4"><NativeQuestions visible={questions.open} scope={questions.moduleId} onOpenSource={openQuestionSource} tablet={tablet} worksheetModule={worksheetModule} /></main>}
  </NativePdfWorkspace></EditorHostProvider>;
}
