import { cardsChanged } from "./card-events";
import { call as invoke } from "./backend.ts";
import { queryClient } from "@/lib/query-client";
import { assertWritable, MUTATIONS, type WritePermit } from "./write-lifecycle.ts";

// Admission is synchronous with mutation registration. Restore/quit suspend
// admission and drain these mutations before replacing or closing the database.
export function writeCards<T>(command: string, args: Record<string, unknown>, permit?: WritePermit): Promise<T> {
  try { assertWritable(permit); } catch (error) { return Promise.reject(error); }
  return queryClient.getMutationCache().build<T, Error, void, unknown>(queryClient, {
    mutationKey: [MUTATIONS.cardWrite],
    gcTime: 0,
    mutationFn: () => invoke<T>(command, args),
  }).execute(undefined).then(result => { cardsChanged(); return result; });
}
