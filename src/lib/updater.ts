import { createStore } from "@tanstack/react-store";
import { check } from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  // `progress` is a fraction, or null when the server doesn't send a size.
  | { state: "downloading"; version: string; progress: number | null }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export const updateStore = createStore<UpdateStatus>({ state: "idle" });

// How long "up to date" stays visible before returning to idle.
const UP_TO_DATE_DURATION = 10_000;
// A manual check spins at least this long, so a quick answer still reads as a check.
const MIN_CHECK_DURATION = 1_000;

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function showUpToDate() {
  const status: UpdateStatus = { state: "up-to-date" };
  updateStore.setState(() => status);
  window.setTimeout(() => {
    // Leave any newer status, such as a check started in the meantime.
    if (updateStore.state === status) updateStore.setState(() => ({ state: "idle" }));
  }, UP_TO_DATE_DURATION);
}

// Checks for a newer release and installs it. On macOS/Linux the new version
// takes effect after a restart; on Windows the installer restarts the app.
// `manual` reports "up to date" too; the startup check stays quiet then.
export async function checkForUpdates({ manual = false } = {}) {
  const { state } = updateStore.state;
  if (state === "checking" || state === "downloading" || state === "ready") return;
  if (import.meta.env.DEV && !manual) return;

  updateStore.setState(() => ({ state: "checking" }));
  try {
    const [update] = await Promise.all([
      import.meta.env.DEV ? null : check(),
      manual ? delay(MIN_CHECK_DURATION) : null,
    ]);
    if (!update) {
      if (manual) showUpToDate();
      else updateStore.setState(() => ({ state: "idle" }));
      return;
    }

    const { version } = update;
    let total: number | undefined;
    let received = 0;
    updateStore.setState(() => ({ state: "downloading", version, progress: null }));
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        updateStore.setState(() => ({
          state: "downloading",
          version,
          progress: total ? Math.min(received / total, 1) : null,
        }));
      }
    });
    updateStore.setState(() => ({ state: "ready", version }));
  } catch (error) {
    console.error("Update failed:", error);
    updateStore.setState(() => ({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

export const RESTART_REQUEST_EVENT = "memnoter:request-restart";

// Goes through the same unsaved-edits checks as Quit; see SaveStatus.
export function restartToUpdate() {
  window.dispatchEvent(new Event(RESTART_REQUEST_EVENT));
}
