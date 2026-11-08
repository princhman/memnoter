import { createStore } from "@tanstack/react-store";
import { queryClient } from "@/lib/query-client";
import { flushSaves, saveQueue } from "@/lib/saves";

let exclusive = false;
const listeners = new Set<(blocked: boolean) => void>();
type TrackedWriteWork = {
  run: () => Promise<unknown>;
  rollbackOnFailure?: boolean;
  pending?: Promise<unknown>;
  error?: string;
  retry?: boolean;
  dispose?: () => void;
};
const trackedWork = new Set<TrackedWriteWork>();
export const imageStatusStore = createStore({ errors: [] as string[] });
const publishWork = () => imageStatusStore.setState(() => ({
  errors: [...trackedWork].flatMap(work => work.error ? [work.error] : []),
}));

export function watchWriteAdmission(listener: (blocked: boolean) => void) {
  listeners.add(listener);
  listener(exclusive);
  return () => { listeners.delete(listener); };
}

function disposeWork(work: TrackedWriteWork) {
  try { work.dispose?.(); }
  catch (error) { console.error("Failed to notify image operation disposal:", error); }
}

async function runWork(work: TrackedWriteWork) {
  work.error = undefined;
  const pending = Promise.resolve().then(work.run);
  work.pending = pending;
  publishWork();
  try {
    const result = await pending;
    trackedWork.delete(work);
    disposeWork(work);
    return result;
  } catch (error) {
    if (work.rollbackOnFailure) trackedWork.delete(work);
    else work.error = `An image could not be saved: ${error instanceof Error ? error.message : String(error)}${work.retry ? "" : ". Keep editing to reapply it, then explicitly discard this failed operation."}`;
    throw error;
  } finally {
    work.pending = undefined;
    publishWork();
  }
}

// A retry callback must resume its own progress, never replay completed inserts.
// Without that guarantee the failure remains actionable until explicit discard.
export async function imageOperation<T>(operation: (permit: WritePermit) => Promise<T>, options: {
  retry?: boolean; dispose?: () => void;
} = {}): Promise<T> {
  assertWritable();
  const work: TrackedWriteWork = { run: () => operation(drainPermit), ...options };
  trackedWork.add(work);
  return await runWork(work) as T;
}

// Imports roll back ordinary failures themselves. Share image admission and
// draining so restore/quit wait through the entire operation and its rollback.
export async function writeOperation<T>(operation: (permit: WritePermit) => Promise<T>): Promise<T> {
  assertWritable();
  const work: TrackedWriteWork = { run: () => operation(drainPermit), rollbackOnFailure: true };
  trackedWork.add(work);
  return await runWork(work) as T;
}

// Upload receipts and completed insertions survive transport failures separately.
export function imageFilesOperation<File, Saved>(files: readonly File[], handlers: {
  checkTarget: (permit: WritePermit) => void;
  upload: (file: File, permit: WritePermit) => Promise<Saved>;
  insert: (saved: Saved, file: File) => void;
  dispose: () => void;
}) {
  let next = 0;
  let receipt: { value: Saved } | undefined;
  return imageOperation(async permit => {
    while (next < files.length) {
      handlers.checkTarget(permit);
      receipt ??= { value: await handlers.upload(files[next], permit) };
      handlers.checkTarget(permit);
      handlers.insert(receipt.value, files[next]);
      next++;
      receipt = undefined;
    }
  }, { retry: true, dispose: handlers.dispose });
}

export async function retryFailedImages() {
  assertWritable();
  await Promise.allSettled([...trackedWork].filter(work => work.error && work.retry && !work.pending).map(runWork));
}

export function discardFailedImages() {
  if (exclusive) throw new Error("Another database operation is in progress.");
  for (const work of trackedWork) if (work.error && !work.pending) {
    trackedWork.delete(work);
    disposeWork(work);
  }
  publishWork();
}

async function drainMutations(excluded?: string, writesOnly = false) {
  const pending = () => queryClient.isMutating({
    predicate: mutation => {
      const key = mutation.options.mutationKey?.[0];
      return key !== excluded && (!writesOnly || key === MUTATIONS.cardWrite ||
        key === MUTATIONS.searchIndex || key === MUTATIONS.compactContent);
    },
  }) > 0;
  if (!pending()) return;
  await new Promise<void>(resolve => {
    const stop = queryClient.getMutationCache().subscribe(() => {
      if (!pending()) { stop(); resolve(); }
    });
    if (!pending()) { stop(); resolve(); }
  });
}

// An exclusive operation names its intent rather than coordinating independent flags.
export type ExclusiveWork =
  | { kind: "restore" }
  | { kind: "delete" }
  | { kind: "exit"; unsaved?: "discard" | "retry" };

export async function exclusiveWrite<T>(action: () => Promise<T>, work?: ExclusiveWork): Promise<T> {
  if (!isWriteAdmitted()) throw new Error("Another database operation is in progress. Please retry.");
  exclusive = true;
  listeners.forEach(listener => listener(true));
  const discard = work?.kind === "exit" && work.unsaved === "discard";
  let suspended = false;
  let completed = false;
  try {
    await settleWork(discard, work?.kind === "exit" && work.unsaved === "retry");
    if (!discard) await flushAll({ timeoutMs: 3_000, permit: drainPermit });
    await saveQueue.suspend();
    suspended = true;
    await drainMutations(work?.kind === "restore" ? MUTATIONS.restoreBackup : work?.kind === "delete" ? MUTATIONS.deleteModule : undefined);
    const result = await action();
    if (discard) {
      for (const item of trackedWork) disposeWork(item);
      trackedWork.clear();
      publishWork();
    }
    completed = true;
    return result;
  } finally {
    if (!completed || (work?.kind !== "restore" && work?.kind !== "exit")) {
      if (suspended) saveQueue.resume();
      exclusive = false;
      listeners.forEach(listener => listener(false));
    }
  }
}

async function settleWork(discard = false, retry = false) {
  const work = [...trackedWork];
  await Promise.allSettled(work.flatMap(item => item.pending ? [item.pending] : []));
  if (!discard && retry) await Promise.allSettled(work.filter(item => trackedWork.has(item) && item.error && item.retry).map(runWork));
  if (!discard && [...trackedWork].some(item => item.error)) throw new Error(imageStatusStore.state.errors.join("\n"));
}

export const MUTATIONS = {
  restoreBackup: "restore-backup", cardWrite: "card-write", searchIndex: "search-index",
  deleteModule: "delete-module", compactContent: "compact-content",
  uploadFile: "upload-file", backupNow: "backup-now",
} as const;

// Only registered flushers receive permission to finish admitted work after
// exclusive admission closes. Ordinary callers cannot obtain this identity.
const drainPermit = Symbol("drain admitted writes");
export type WritePermit = typeof drainPermit;
export function isWriteAdmitted(permit?: WritePermit) {
  return !saveQueue.isSuspended() && (!exclusive || permit === drainPermit);
}
export function assertWritable(permit?: WritePermit) {
  if (!isWriteAdmitted(permit)) throw new Error("Writes are suspended.");
}
export function isRestoring() {
  return queryClient.isMutating({ mutationKey: [MUTATIONS.restoreBackup] }) > 0;
}

const flushers = new Map<string, (permit?: WritePermit) => Promise<unknown>>();
export function registerFlusher(name: string, fn: (permit?: WritePermit) => Promise<unknown>) {
  flushers.set(name, fn);
  return () => { if (flushers.get(name) === fn) flushers.delete(name); };
}

export async function flushAll({ timeoutMs = 3_000, permit }: { timeoutMs?: number; permit?: WritePermit } = {}) {
  if (permit !== drainPermit) assertWritable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await settleWork();
        for (const flush of flushers.values()) await flush(permit);
        if (!await flushSaves(timeoutMs)) throw new Error("Pending edits could not be saved. Please retry saving first.");
        await drainMutations(undefined, true);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out saving pending writes.")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
