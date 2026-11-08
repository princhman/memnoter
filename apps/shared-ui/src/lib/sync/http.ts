// Keep the deadline and stop listener alive until the response body is consumed.
// Race as well as abort: a broken transport must not hold the lifecycle queue.
export async function syncRequest<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response, progress: () => void, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    const error = new DOMException("Sync request cancelled or timed out", "AbortError");
    rejectAbort(error);
    controller.abort(error);
  };
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(abort, timeoutMs);
  };
  signal?.addEventListener("abort", abort, { once: true });
  progress();
  if (signal?.aborted) abort();
  try {
    return await Promise.race([
      aborted,
      (async () => {
        controller.signal.throwIfAborted();
        const response = await fetch(url, { ...init, signal: controller.signal });
        controller.signal.throwIfAborted();
        const result = await consume(response, progress, controller.signal);
        controller.signal.throwIfAborted();
        return result;
      })(),
    ]);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener("abort", abort);
  }
}

// Upload progress is unavailable in fetch. Budget at least 32 KiB/s plus two
// minutes for setup; downloads instead renew their deadline with every chunk.
export const transferTimeout = (bytes = 0) => 120_000 + Math.ceil(bytes / 32_768) * 1_000;

export async function readTransfer(response: Response, progress: () => void, signal: AbortSignal) {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(error => console.error("Failed to cancel sync response:", error)); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
      progress();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
