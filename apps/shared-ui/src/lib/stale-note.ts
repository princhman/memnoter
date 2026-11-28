// The core's answer when another window saved the note after this snapshot.
const STALE_NOTE = "Note changed in another window";

export const isStaleNote = (error: unknown) =>
  String(error instanceof Error ? error.message : error).includes(STALE_NOTE);
