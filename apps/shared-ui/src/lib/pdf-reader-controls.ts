// The open reader's state and actions, for a host that draws the reader's
// tools itself (the native iPad toolbar). Only one reader is native at a time.
export interface PdfReaderViewState {
  page: number;
  pageCount: number;
  zoom: number;
  selecting: boolean;
  annotating: boolean;
  canSelect: boolean;
  canAnnotate: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
}
export interface PdfReaderActions {
  zoomIn(): void;
  zoomOut(): void;
  toggleSelect(): void;
  toggleAnnotate(): void;
  goToPage(page: number): void;
  openBeside(): void;
}
export interface PdfReaderControls { documentId: string; state: PdfReaderViewState; actions: PdfReaderActions }

let current: PdfReaderControls | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export const pdfReaderControls = {
  get: () => current,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  /** Returns a release that only clears this reader's own registration. */
  set(next: PdfReaderControls) {
    current = next; notify();
    return () => { if (current?.documentId === next.documentId) { current = null; notify(); } };
  },
};
