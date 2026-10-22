import { check } from "@tauri-apps/plugin-updater";

// Downloads and installs a newer release in the background. On macOS/Linux the
// new version takes effect on next launch; on Windows the installer restarts the app.
export async function installUpdateInBackground() {
  if (import.meta.env.DEV) return;

  try {
    const update = await check();
    if (!update) return;
    await update.downloadAndInstall();
  } catch (error) {
    console.error("Update check failed:", error);
  }
}
