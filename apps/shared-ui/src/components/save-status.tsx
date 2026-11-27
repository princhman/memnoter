import { toast } from "sonner";
import { pdfAnnotationSaveStatusStore, retryPdfAnnotationSaves } from "@/lib/pdf-annotation-store";
import { capabilities } from "@/lib/backend";
import { exclusiveWrite, isRestoring, imageStatusStore, discardFailedImages, retryFailedImages, watchWriteAdmission } from "@/lib/write-lifecycle";
import { useEffect, useRef, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { call as invoke } from "../lib/backend.ts";
import { listen } from "../lib/backend.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { queryClient } from "@/lib/query-client";
import { saveQueue, saveStatusStore } from "@/lib/saves";
import { RESTART_REQUEST_EVENT } from "@/lib/updater";

const restorePending = isRestoring;

const IMAGE_ERRORS_TOAST = "image-errors";
const SAVE_FAILING_TOAST = "save-failing";

// Restore owns the database until its mutation (including success/rollback)
// settles. Neither ordinary Quit nor the discard-edits action may interrupt it.
async function waitForRestore() {
  if (!restorePending()) return;
  await new Promise<void>((resolve) => {
    const stop = queryClient.getMutationCache().subscribe(() => {
      if (!restorePending()) { stop(); resolve(); }
    });
    if (!restorePending()) { stop(); resolve(); }
  });
}

// Set by whichever request (Quit/close or Restart to update) is in progress.
type ExitCommand = "confirm_exit" | "confirm_restart" | "confirm_window_close";
let exitCommand: ExitCommand = "confirm_exit";

async function confirmExitAfterRestore(discard = false, retryImages = false) {
  await waitForRestore();
  if (restorePending()) throw new Error("Restore is in progress.");
  const command = exitCommand;
  await exclusiveWrite(async () => {
    await invoke(command);
    if (command === "confirm_window_close" && discard) {
      saveQueue.clear();
      window.location.reload();
    }
  }, {
    kind: command === "confirm_window_close" ? "close" : "exit",
    unsaved: discard ? "discard" : retryImages ? "retry" : undefined,
  });
}

// Shown once saving has failed repeatedly. Editing carries on meanwhile and
// the queue keeps retrying in the background.
const SaveStatus = () => {
  const annotations = useSelector(pdfAnnotationSaveStatusStore, state => state);
  const imageErrors = useSelector(imageStatusStore, state => state.errors);
  const showingImageError = useRef(false);
  const [exitError, setExitError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => watchWriteAdmission(setBlocked), []);
  const failing = useSelector(saveStatusStore, (state) => state.failing);
  const lastError = useSelector(saveStatusStore, (state) => state.lastError);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closingWindow, setClosingWindow] = useState(false);
  const changeConfirmClose = (open: boolean) => {
    setConfirmClose(open);
    if (!open) void invoke("cancel_window_exit").catch(console.error);
  };

  useEffect(() => {
    const id = "pdf-annotation-saves";
    if (!annotations.pending) { toast.dismiss(id); return; }
    const message = annotations.failing ? "PDF annotations not saved" : "Saving PDF annotations…";
    toast(message, { id, duration: Infinity, description: annotations.lastError ?? undefined,
      action: annotations.failing ? { label: "Retry annotations", onClick: event => { event.preventDefault(); if (!blocked) retryPdfAnnotationSaves(); } } : undefined });
  }, [annotations, blocked]);

  // Both messages stay for as long as the problem does. Their actions keep
  // the toast open (preventDefault): it goes away only when the cause does.
  useEffect(() => {
    if (!imageErrors.length) {
      if (showingImageError.current) toast.dismiss(IMAGE_ERRORS_TOAST);
      showingImageError.current = false;
      return;
    }
    showingImageError.current = true;
    toast.error("Image changes could not be saved", {
      id: IMAGE_ERRORS_TOAST,
      description: <>{imageErrors.map((error, index) => <p key={index}>{error}</p>)}</>,
      duration: Infinity,
      cancel: { label: "Retry images", onClick: event => { event.preventDefault(); if (!blocked) void retryFailedImages(); } },
      action: { label: "Discard failed image operations", onClick: event => { event.preventDefault(); if (!blocked) discardFailedImages(); } },
    });
  }, [imageErrors, blocked]);
  useEffect(() => {
    if (!failing) { toast.dismiss(SAVE_FAILING_TOAST); return; }
    toast.error("Not saved", {
      id: SAVE_FAILING_TOAST,
      description: lastError ?? undefined,
      duration: Infinity,
      action: { label: "Retry", onClick: event => { event.preventDefault(); void saveQueue.flush(); } },
    });
  }, [failing, lastError]);

  useEffect(() => {
    if (!capabilities.appExit) return;
    let disposed = false;

    let busy = false;
    let queued: ExitCommand | undefined;
    const requestExit = async (command: ExitCommand) => {
      if (busy) {
        if (command !== exitCommand) queued = command;
        return;
      }
      busy = true;
      exitCommand = command;
      setClosingWindow(command === "confirm_window_close");
      try {
        await waitForRestore();
        if (disposed || restorePending()) return;
        await confirmExitAfterRestore();
      } catch (error) {
        setExitError(error instanceof Error ? error.message : String(error));
        setConfirmClose(true);
      } finally {
        busy = false;
        const next = queued;
        queued = undefined;
        if (next && !disposed) void requestExit(next);
      }
    };
    const stops: (() => void)[] = [];
    void Promise.all([
      listen("request-safe-exit", () => void requestExit("confirm_exit")),
      listen("request-safe-close", () => void requestExit("confirm_window_close")),
      listen("request-safe-restart", () => void requestExit("confirm_restart")),
    ]).then((listeners) => {
      if (disposed) listeners.forEach(stop => stop());
      else stops.push(...listeners);
    }).catch(console.error);
    const requestRestart = () => void invoke("request_restart").catch(error => toast.error(error.message));
    window.addEventListener(RESTART_REQUEST_EVENT, requestRestart);
    return () => {
      disposed = true;
      window.removeEventListener(RESTART_REQUEST_EVENT, requestRestart);
      stops.forEach(stop => stop());
    };
  }, []);

  return (
    <>
      <Dialog open={confirmClose} onOpenChange={changeConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{closingWindow ? "Close without saving?" : "Quit without saving?"}</DialogTitle>
            <DialogDescription>
              Some changes could not be saved. Unsaved changes in this window will be lost if you continue.
              {exitError && <span role="alert" className="block">{exitError}</span>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline">Keep editing</Button>}
            />
            <Button disabled={retrying || blocked} onClick={() => {
              setRetrying(true);
              void confirmExitAfterRestore(false, true).catch(error => {
                setExitError(error instanceof Error ? error.message : String(error));
                setConfirmClose(true);
              }).finally(() => setRetrying(false));
            }}>{retrying ? "Saving…" : "Retry saving"}</Button>
            <Button
              variant="destructive"
              disabled={retrying || blocked}
              onClick={() => void confirmExitAfterRestore(true).catch(() => setConfirmClose(true))}
            >
              {closingWindow ? "Close anyway" : "Quit anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default SaveStatus;
