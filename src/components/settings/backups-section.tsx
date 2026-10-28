import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { invoke } from "@tauri-apps/api/core";
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

type Backup = {
  id: string;
  created_at: number;
};

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const RestoreBackup = ({
  backup,
  onOpenChange,
}: {
  backup: Backup | null;
  onOpenChange: (open: boolean) => void;
}) => {
  const pending = useSelector(saveStatusStore, (state) => state.pending);
  const mutation = useMutation({
    mutationFn: async (id: string) => {
      // Save what still can be, so the snapshot taken first includes it.
      await flushSaves(3_000);
      // Anything left would be written into the restored database.
      saveQueue.clear();
      await invoke("restore_backup", { id });
    },
    // Every cache and open document belongs to the replaced data.
    onSuccess: () => window.location.reload(),
  });

  return (
    <Dialog
      open={backup !== null}
      onOpenChange={(nextOpen) => {
        if (mutation.isPending) return;
        mutation.reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent showCloseButton={!mutation.isPending}>
        <DialogHeader>
          <DialogTitle>Restore backup?</DialogTitle>
          <DialogDescription>
            All notes and images will be replaced with the backup from{" "}
            {backup && formatTime(backup.created_at)}. The current state is
            backed up first, so you can restore it again from this list.
            {pending > 0 &&
              " Edits that could not be saved yet will be discarded."}
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {String(mutation.error)}
          </p>
        )}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" disabled={mutation.isPending}>
                Cancel
              </Button>
            }
          />
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => backup && mutation.mutate(backup.id)}
          >
            {mutation.isPending ? "Restoring..." : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const BackupsSection = () => {
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const { data: backups, isPending, error } = useQuery({
    queryKey: ["backups"],
    queryFn: () => invoke<Backup[]>("list_backups"),
  });
  const backupNow = useMutation({
    mutationFn: () => invoke<Backup>("backup_now"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["backups"] }),
  });

  const latest = backups?.[0];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">Backups</h2>
          <p className="text-sm text-muted-foreground">
            {latest
              ? `Last backup: ${formatTime(latest.created_at)}.`
              : !isPending && "No backups yet."}{" "}
            A backup is made once a day when the app opens, and the newest 7
            are kept.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={backupNow.isPending}
          onClick={() => backupNow.mutate()}
        >
          {backupNow.isPending ? "Backing up..." : "Back up now"}
        </Button>
      </div>

      {backupNow.isError && (
        <p role="alert" className="text-sm text-destructive">
          {String(backupNow.error)}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {String(error)}
        </p>
      )}

      {backups && backups.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {backups.map((backup) => (
            <li
              key={backup.id}
              className="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-3 text-sm"
            >
              <span>{formatTime(backup.created_at)}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setRestoring(backup)}
              >
                Restore…
              </Button>
            </li>
          ))}
        </ul>
      )}

      <RestoreBackup
        backup={restoring}
        onOpenChange={(open) => !open && setRestoring(null)}
      />
    </section>
  );
};

export default BackupsSection;
