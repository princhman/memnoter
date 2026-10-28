import { flushCardSyncs } from "@/lib/card-sync";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { flushSaves, saveQueue } from "@/lib/saves";

export type Backup = { id: string; created_at: number };

// The Settings button and palette share admission, flush, and cache refresh.
export function useBackupNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["backup-now"],
    mutationFn: async () => {
      const blocked = () => saveQueue.isSuspended() ||
        queryClient.isMutating({ mutationKey: ["restore-backup"] }) > 0;
      if (blocked() || queryClient.isMutating({ mutationKey: ["backup-now"] }) > 1) {
        throw new Error("A backup or restore is already in progress.");
      }
      await flushCardSyncs();
      if (!await flushSaves(3_000)) {
        throw new Error("Save pending edits before backing up. Please retry saving first.");
      }
      if (blocked()) throw new Error("Restore is in progress.");
      return invoke<Backup>("backup_now");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["backups"] }),
  });
}
