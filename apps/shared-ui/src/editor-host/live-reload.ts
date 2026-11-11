// Imported only by the LAN dev server, never by bundled or production entries.
import { exclusiveWrite } from "@/lib/write-lifecycle";
import { flushPersistedViews } from "@/lib/view-persistence";

let revision: string | undefined;
let checking = false;
let composing = false;
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => { composing = false; });
const note = document.createElement("div");
note.style.cssText = "position:fixed;bottom:4px;right:8px;font:11px system-ui;z-index:99999;pointer-events:none;background:Canvas;color:CanvasText";
note.textContent = "Live editor";
document.body.append(note);
setInterval(async () => {
  if (checking || composing || document.hidden) return;
  checking = true;
  try {
    let response: Response;
    try { response = await fetch("/__ios_revision", { cache: "no-store", signal: AbortSignal.timeout(2500) }); }
    catch {
      if (composing) return;
      const handler = (window.webkit?.messageHandlers as unknown as Record<string, { postMessage(value: object): void }> | undefined)?.memnoterLive;
      if (!handler) throw new Error("Dev server unavailable");
      flushPersistedViews();
      await exclusiveWrite(async () => { handler.postMessage({ fallback: true }); }, { kind: "exit" });
      return;
    }
    if (!response.ok) throw new Error("Dev server unavailable");
    const next = await response.text();
    if (revision === undefined) revision = next;
    if (next === revision || composing) return;
    // Wait for composition and native review operations rather than interrupting.
    if (document.querySelector(".ProseMirror")?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement)?.blur();
    }
    flushPersistedViews();
    await exclusiveWrite(async () => { location.reload(); }, { kind: "exit" });
  } catch (error) {
    note.textContent = `Live reload paused: ${error instanceof Error ? error.message : error}`;
  } finally { checking = false; }
}, 1000);
