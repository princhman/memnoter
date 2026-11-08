import { startBackfill } from "@/lib/note-index";

// Shared by the desktop and WKWebView editor entry points.
export function bootstrapNotes() {
  return startBackfill();
}
