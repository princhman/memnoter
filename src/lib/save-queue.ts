// Persists editor updates per module, strictly in order, retrying failures
// with backoff. Independent of React so pending saves outlive the editor.

export type SaveQueueStatus = {
  // Updates not yet persisted, across all modules.
  pending: number;
  // Saving has kept failing; the user should know their edits are not on disk.
  failing: boolean;
  lastError: string | null;
};

type Timers = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type SaveQueueOptions<Update, Saved> = {
  persist: (moduleId: string, update: Update) => Promise<Saved>;
  // Called in the same tick the update leaves the queue.
  onSaved?: (moduleId: string, saved: Saved) => void;
  onStatus?: (status: SaveQueueStatus) => void;
  onError?: (moduleId: string, error: unknown) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  // Report failure after this many failed attempts in a row, or this long.
  failAfterAttempts?: number;
  failAfterMs?: number;
  timers?: Timers;
};

type ModuleQueue<Update> = {
  items: Update[];
  running: boolean;
  attempts: number;
  failingSince: number | null;
  wake: (() => void) | null;
  dropped: boolean;
};

export function createSaveQueue<Update, Saved>({
  persist,
  onSaved,
  onStatus,
  onError,
  initialDelayMs = 500,
  maxDelayMs = 30_000,
  failAfterAttempts = 3,
  failAfterMs = 5_000,
  timers = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
}: SaveQueueOptions<Update, Saved>) {
  const queues = new Map<string, ModuleQueue<Update>>();
  let suspended = false;
  const active = new Set<Promise<unknown>>();
  let lastError: string | null = null;
  let flushWaiters: ((saved: boolean) => void)[] = [];

  const isFailing = (queue: ModuleQueue<Update>) =>
    queue.attempts >= failAfterAttempts ||
    (queue.failingSince !== null &&
      timers.now() - queue.failingSince >= failAfterMs);

  function status(): SaveQueueStatus {
    let pending = 0;
    let failing = false;
    for (const queue of queues.values()) {
      pending += queue.items.length;
      failing ||= isFailing(queue);
    }
    return { pending, failing, lastError: failing ? lastError : null };
  }

  function notify() {
    onStatus?.(status());
  }

  function settleFlush(saved: boolean) {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) resolve(saved);
  }

  function sleep(queue: ModuleQueue<Update>, ms: number) {
    return new Promise<void>((resolve) => {
      const handle = timers.setTimeout(() => {
        queue.wake = null;
        resolve();
      }, ms);
      queue.wake = () => {
        timers.clearTimeout(handle);
        queue.wake = null;
        resolve();
      };
    });
  }

  // Skips the current backoff wait of every failing module.
  function retryNow() {
    for (const queue of queues.values()) queue.wake?.();
  }

  function drop(moduleId: string) {
    const queue = queues.get(moduleId);
    if (!queue) return;
    queue.dropped = true;
    queues.delete(moduleId);
    queue.wake?.();
    notify();
    if (queues.size === 0) settleFlush(true);
  }

  async function drain(moduleId: string, queue: ModuleQueue<Update>) {
    if (queue.running) return;
    queue.running = true;
    while (queue.items.length > 0 && !queue.dropped && !suspended) {
      try {
        const write = persist(moduleId, queue.items[0]);
        active.add(write);
        let saved: Saved;
        try { saved = await write; } finally { active.delete(write); }
        if (queue.dropped) break;
        queue.items.shift();
        queue.attempts = 0;
        queue.failingSince = null;
        onSaved?.(moduleId, saved);
        notify();
      } catch (error) {
        if (queue.dropped) break;
        queue.attempts += 1;
        queue.failingSince ??= timers.now();
        lastError = error instanceof Error ? error.message : String(error);
        onError?.(moduleId, error);
        notify();
        settleFlush(false);
        const delay = Math.min(
          initialDelayMs * 2 ** (queue.attempts - 1),
          maxDelayMs,
        );
        await sleep(queue, delay);
      }
    }
    queue.running = false;
    if (queues.get(moduleId) === queue && queue.items.length === 0) {
      queues.delete(moduleId);
    }
    notify();
    if (queues.size === 0) settleFlush(true);
  }

  return {
    async suspend() {
      suspended = true;
      retryNow();
      await Promise.allSettled([...active]);
    },
    resume() {
      suspended = false;
      for (const [id, queue] of queues) void drain(id, queue);
    },
    enqueue(moduleId: string, update: Update) {
      let queue = queues.get(moduleId);
      if (!queue) {
        queue = {
          items: [],
          running: false,
          attempts: 0,
          failingSince: null,
          wake: null,
          dropped: false,
        };
        queues.set(moduleId, queue);
      }
      queue.items.push(update);
      notify();
      void drain(moduleId, queue);
    },

    // Updates for the module that are not yet persisted, oldest first.
    pending(moduleId: string): readonly Update[] {
      return [...(queues.get(moduleId)?.items ?? [])];
    },

    // No queued or in-flight update for the module. Compaction relies on
    // update ids, so it must only run then.
    isIdle(moduleId: string) {
      return !queues.has(moduleId);
    },

    isEmpty() {
      return queues.size === 0;
    },

    status,
    retryNow,

    // Resolves true once everything is persisted, or false on the next failure.
    flush(): Promise<boolean> {
      if (queues.size === 0) return Promise.resolve(true);
      const result = new Promise<boolean>((resolve) => {
        flushWaiters.push(resolve);
      });
      retryNow();
      return result;
    },

    // The module is gone; its updates can never be saved.
    drop,

    // Discards every pending update, e.g. before replacing the database.
    clear() {
      for (const moduleId of [...queues.keys()]) drop(moduleId);
    },
  };
}

export type SaveQueue<Update, Saved> = ReturnType<
  typeof createSaveQueue<Update, Saved>
>;
