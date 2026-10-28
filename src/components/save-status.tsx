import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
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
import { flushSaves, saveQueue, saveStatusStore } from "@/lib/saves";

const CLOSE_FLUSH_TIMEOUT_MS = 3_000;

// Shown once saving has failed repeatedly. Editing carries on meanwhile and
// the queue keeps retrying in the background.
const SaveStatus = () => {
  const failing = useSelector(saveStatusStore, (state) => state.failing);
  const lastError = useSelector(saveStatusStore, (state) => state.lastError);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (saveQueue.isEmpty()) return;
        if (await flushSaves(CLOSE_FLUSH_TIMEOUT_MS)) return;
        event.preventDefault();
        setConfirmClose(true);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
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
            <Button
              variant="destructive"
              onClick={() => void getCurrentWindow().destroy()}
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
