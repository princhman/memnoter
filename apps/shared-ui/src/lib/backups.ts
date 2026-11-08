import { MUTATIONS } from "@/lib/write-lifecycle";
import { flushAll, isWriteAdmitted, isRestoring } from "./write-lifecycle";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call as invoke } from "./backend.ts";

export type Backup = { id: string; created_at: number };

// The Settings button and palette share admission, flush, and cache refresh.
export function useBackupNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [MUTATIONS.backupNow],
    mutationFn: async () => {
      const blocked = () => !isWriteAdmitted() || isRestoring();
      if (blocked() || queryClient.isMutating({ mutationKey: [MUTATIONS.backupNow] }) > 1) {
        throw new Error("A backup or restore is already in progress.");
      }
      await flushAll();
      if (blocked()) throw new Error("Restore is in progress.");
      return invoke<Backup>("backup_now");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["backups"] }),
  });
}
