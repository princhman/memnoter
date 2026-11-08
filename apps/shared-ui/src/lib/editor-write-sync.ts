import { settled } from "@/lib/async-work";
import type { WritePermit } from "@/lib/write-lifecycle";

// Both derived indexes share debounce ownership and retain writes started by
// unmount cleanup until the final application flush has observed them.
export function createEditorWriteSync(delay: number) {
  const active = new Set<(permit?: WritePermit) => Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(write: Promise<T>) {
      pending.add(write);
      void settled(write).then(() => pending.delete(write));
      return write;
    },
    async flush(permit?: WritePermit) {
      await Promise.all([...active].map(flush => flush(permit)));
      await Promise.all([...pending]);
    },
    attach(flush: (permit?: WritePermit) => Promise<unknown>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      active.add(flush);
      const run = () => { clearTimeout(timer); timer = undefined; void flush().catch(console.error); };
      const pagehide = () => run();
      window.addEventListener("pagehide", pagehide);
      return {
        schedule() { clearTimeout(timer); timer = setTimeout(run, delay); },
        cancel() { clearTimeout(timer); timer = undefined; },
        stop() {
          if (timer !== undefined) run();
          active.delete(flush);
          window.removeEventListener("pagehide", pagehide);
        },
      };
    },
  };
}
