import { invoke } from "@tauri-apps/api/core";
import { queryClient } from "@/lib/query-client";
import { saveQueue } from "@/lib/saves";

// Admission is synchronous with mutation registration. Restore/quit suspend
// admission and drain these mutations before replacing or closing the database.
export function writeCards<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (saveQueue.isSuspended()) return Promise.reject(new Error("Card writes are suspended."));
  return queryClient.getMutationCache().build<T, Error, void, unknown>(queryClient, {
    mutationKey: ["card-write"],
    gcTime: 0,
    mutationFn: () => invoke<T>(command, args),
  }).execute(undefined);
}

export async function drainCardWrites() {
  const pending = () => queryClient.isMutating({ mutationKey: ["card-write"] }) > 0;
  if (!pending()) return;
  await new Promise<void>(resolve => {
    const stop = queryClient.getMutationCache().subscribe(() => {
      if (!pending()) { stop(); resolve(); }
    });
    if (!pending()) { stop(); resolve(); }
  });
}
