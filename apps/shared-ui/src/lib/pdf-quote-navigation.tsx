import { useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createStore, useSelector } from "@tanstack/react-store";
import { useRouter } from "@tanstack/react-router";
import { NodeSelection } from "@tiptap/pm/state";
import { useActiveEditor } from "./active-editor-context";
import { getFocusedSectionRange, sectionFocusKey } from "./section-focus";
import { getFoldedRanges, headingFoldKey } from "./heading-fold";
import { Toast } from "@/components/ui/toast";

type Target = { moduleId: string; quoteId: string; cancel: () => void };
const pending = createStore<Target | null>(null);
let active: Target | null = null;
function clear(target: Target) {
  if (active !== target) return;
  target.cancel();
  active = null;
  if (pending.state === target) pending.setState(() => null);
}

// Failures can occur in the fullscreen reader, where the note isn't mounted.
function feedback(message: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const dismiss = () => { clearTimeout(timer); root.unmount(); host.remove(); };
  const timer = setTimeout(dismiss, 6000);
  root.render(<Toast role="status" className="flex items-center gap-3 px-3 py-2 text-sm">
    {message}<button type="button" className="underline underline-offset-2" onClick={dismiss}>Dismiss</button>
  </Toast>);
}

export function usePdfQuoteNavigation(moduleId: string): (quoteId: string) => void {
  const router = useRouter();
  return useCallback((quoteId: string) => {
    if (active) clear(active);
    if (!quoteId) { feedback("This quote is no longer available in the note."); return; }
    const destination = router.buildLocation({ to: "/$moduleId", params: { moduleId } });
    const isDestination = (pathname: string) => pathname.replace(/\/$/, "") === destination.pathname.replace(/\/$/, "");
    const token = crypto.randomUUID();
    const target: Target = { moduleId, quoteId, cancel: () => {} };
    active = target;
    const sameNote = isDestination(router.state.location.pathname);
    // Tag only this history entry: a blocked promise may resolve on a later,
    // unrelated navigation, including a manual visit to the same note.
    target.cancel = router.subscribe("onBeforeNavigate", event => {
      const state = event.toLocation.state;
      if (sameNote || !isDestination(event.toLocation.pathname) ||
        !("pdfQuoteNavigation" in state) || state.pdfQuoteNavigation !== token) clear(target);
    });
    if (sameNote) { pending.setState(() => target); return; }
    void router.navigate({ to: "/$moduleId", params: { moduleId },
      state: previous => ({ ...previous, pdfQuoteNavigation: token }),
    }).then(() => {
      if (active !== target) return;
      const location = router.state.location;
      if (router.state.matches.some(match => match.status === "error")) {
        clear(target);
        feedback("Could not open the note. Try again.");
      } else if (isDestination(location.pathname) && "pdfQuoteNavigation" in location.state && location.state.pdfQuoteNavigation === token) {
        pending.setState(() => target);
      } else clear(target);
    }).catch(() => {
      if (active !== target) return;
      clear(target);
      feedback("Could not open the note. Try again.");
    });
  }, [moduleId, router]);
}

export function PdfQuoteNavigation({ moduleId }: { moduleId: string }) {
  const target = useSelector(pending, state => state);
  const { activeEditor } = useActiveEditor();
  const router = useRouter();
  useEffect(() => {
    if (!target || target.moduleId !== moduleId || !activeEditor?.isReady ||
      activeEditor.moduleId !== moduleId || activeEditor.editor.isDestroyed) return;
    const editor = activeEditor.editor;
    const currentNote = router.state.matches.some(match => "moduleId" in match.params && match.params.moduleId === moduleId);
    if (!currentNote || pending.state !== target) return;
    // Resolve at execution, after loading and restoring the note's saved view.
    let position: number | undefined;
    editor.state.doc.descendants((node, pos) => {
      if (position !== undefined) return false;
      const quoteId = node.type.name === "pdfTextQuote" ? node.attrs.quoteId
        : node.type.name === "image" || node.type.name === "inlineImage" ? node.attrs.imageId : null;
      if (quoteId === target.quoteId) position = pos;
    });
    clear(target);
    if (position === undefined) { feedback("This quote is no longer available in the note."); return; }
    const resolvedPosition = position;
    const state = editor.state;
    const tr = state.tr;
    const focused = getFocusedSectionRange(state);
    if (focused && (resolvedPosition < focused.from || resolvedPosition >= focused.to)) tr.setMeta(sectionFocusKey, { type: "clear" });
    const folds = getFoldedRanges(state);
    const covering = new Set(folds.filter(range => resolvedPosition >= range.from && resolvedPosition < range.to).map(range => range.id));
    if (covering.size) tr.setMeta(headingFoldKey, { type: "set", ids: (headingFoldKey.getState(state)?.folded ?? []).filter(id => !covering.has(id)) });
    tr.setSelection(NodeSelection.create(state.doc, resolvedPosition));
    editor.view.dispatch(tr);
    // Focus without letting the browser scroll the PDF or the outer window.
    editor.view.dom.focus({ preventScroll: true });
    const node = editor.view.nodeDOM(resolvedPosition);
    const container = editor.view.dom.closest(".app-scroll-container");
    if (node instanceof HTMLElement && container instanceof HTMLElement) {
      const bounds = node.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      container.scrollTop += bounds.top - viewport.top - Math.max(16, (viewport.height - bounds.height) / 2);
    }
  }, [target, activeEditor, moduleId, router]);
  return null;
}
