import { exclusiveWrite } from "@/lib/write-lifecycle";
import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle } from "lucide-react";
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

const restorePending = () => queryClient.isMutating({ mutationKey: ["restore-backup"] }) > 0;

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

async function confirmExitAfterRestore(discard = false) {
  await waitForRestore();
  if (restorePending()) throw new Error("Restore is in progress.");
  await exclusiveWrite(() => invoke("confirm_exit"), { discard, retain: true });
}

// Shown once saving has failed repeatedly. Editing carries on meanwhile and
// the queue keeps retrying in the background.
const SaveStatus = () => {
  const failing = useSelector(saveStatusStore, (state) => state.failing);
  const lastError = useSelector(saveStatusStore, (state) => state.lastError);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    let disposed = false;

    let busy = false;
    const requestExit = async () => {
      if (busy) return;
      busy = true;
      try {
        await waitForRestore();
        if (disposed || restorePending()) return;
        await confirmExitAfterRestore();
      } catch {
        setConfirmClose(true);
      } finally { busy = false; }
    };
    const stops: (() => void)[] = [];
    void Promise.all([
      listen("request-safe-exit", () => void requestExit()),
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        void requestExit();
      }),
    ]).then((listeners) => {
      if (disposed) listeners.forEach(stop => stop());
      else stops.push(...listeners);
    });
    return () => {
      disposed = true;
      stops.forEach(stop => stop());
    };
  }, []);

  return (
    <>
      {failing && (
        <div
          role="status"
          title={lastError ?? undefined}
          className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-2.5 text-sm shadow-sm"
        >
          <AlertCircle className="size-4 text-destructive" />
          <span>Not saved</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void saveQueue.flush()}
          >
            Retry
          </Button>
        </div>
      )}

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quit without saving?</DialogTitle>
            <DialogDescription>
              Some changes could not be saved. If you quit now, unsaved changes
              will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline">Keep editing</Button>}
            />
            <Button onClick={() => void confirmExitAfterRestore().catch(() => setConfirmClose(true))}>Retry saving</Button>
            <Button
              variant="destructive"
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
