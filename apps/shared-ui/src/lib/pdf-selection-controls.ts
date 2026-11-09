import type { PdfSelectionAction } from "@/editor-host/protocol";

// Only the mounted native reader owns selection actions.
let current: ((action: PdfSelectionAction, color?: string | null) => void) | null = null;
export const pdfSelectionControls = {
  run(action: PdfSelectionAction, color?: string | null) { current?.(action, color); },
  register(handler: NonNullable<typeof current>) {
    current = handler;
    return () => { if (current === handler) current = null; };
  },
};
