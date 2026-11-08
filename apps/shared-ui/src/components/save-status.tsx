import { toast } from "sonner";
import { capabilities } from "@/lib/backend";
import { exclusiveWrite, isRestoring, imageStatusStore, discardFailedImages, watchWriteAdmission } from "@/lib/write-lifecycle";
import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { call as invoke } from "../lib/backend.ts";
import { listen } from "../lib/backend.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
let exitCommand: "confirm_exit" | "confirm_restart" = "confirm_exit";

async function confirmExitAfterRestore(discard = false, retryImages = false) {
  await waitForRestore();
  if (restorePending()) throw new Error("Restore is in progress.");
  await exclusiveWrite(() => invoke(exitCommand), { kind: "exit", unsaved: discard ? "discard" : retryImages ? "retry" : undefined });
}

// Shown once saving has failed repeatedly. Editing carries on meanwhile and
// the queue keeps retrying in the background.
const SaveStatus = () => {
  const imageErrors = useSelector(imageStatusStore, state => state.errors);
  const [exitError, setExitError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => watchWriteAdmission(setBlocked), []);
  const failing = useSelector(saveStatusStore, (state) => state.failing);
  const lastError = useSelector(saveStatusStore, (state) => state.lastError);
  const [confirmClose, setConfirmClose] = useState(false);

  // Both messages stay for as long as the problem does. Their actions keep
  // the toast open (preventDefault): it goes away only when the cause does.
  useEffect(() => {
    if (!imageErrors.length) { toast.dismiss(IMAGE_ERRORS_TOAST); return; }
    toast.error("Image changes could not be saved", {
      id: IMAGE_ERRORS_TOAST,
      description: <>{imageErrors.map((error, index) => <p key={index}>{error}</p>)}</>,
      duration: Infinity,
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
    const requestExit = async (command: typeof exitCommand) => {
      if (busy) return;
      busy = true;
      exitCommand = command;
      try {
        await waitForRestore();
        if (disposed || restorePending()) return;
        await confirmExitAfterRestore();
      } catch (error) {
        setExitError(error instanceof Error ? error.message : String(error));
        setConfirmClose(true);
      } finally { busy = false; }
    };
    const stops: (() => void)[] = [];
    void Promise.all([
      listen("request-safe-exit", () => void requestExit("confirm_exit")),
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        void requestExit("confirm_exit");
      }),
    ]).then((listeners) => {
      if (disposed) listeners.forEach(stop => stop());
      else stops.push(...listeners);
    });
    const requestRestart = () => void requestExit("confirm_restart");
    window.addEventListener(RESTART_REQUEST_EVENT, requestRestart);
    return () => {
      disposed = true;
      window.removeEventListener(RESTART_REQUEST_EVENT, requestRestart);
      stops.forEach(stop => stop());
    };
  }, []);

  return (
    <>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quit without saving?</DialogTitle>
            <DialogDescription>
              Some changes could not be saved. If you quit now, unsaved changes
              will be lost.
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
              Quit anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default SaveStatus;
