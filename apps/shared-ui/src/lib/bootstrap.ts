import { startBackfill } from "@/lib/note-index";

export function bootstrapNotes() {
  return startBackfill();
}
