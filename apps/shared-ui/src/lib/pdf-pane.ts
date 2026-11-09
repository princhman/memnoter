import { createStore, useSelector } from "@tanstack/react-store";
import { parsePdfPane, type PdfPaneState } from "./pdf-state";
function readPane(moduleId: string): PdfPaneState {
  try { return parsePdfPane(JSON.parse(localStorage.getItem(`pdf-pane:${moduleId}`) ?? "null")); }
  catch { return parsePdfPane(null); }
}
const panes = new Map<string, ReturnType<typeof createStore<PdfPaneState>>>();
function paneStore(moduleId: string) {
  let store = panes.get(moduleId);
  if (!store) { store = createStore(readPane(moduleId)); panes.set(moduleId, store); }
  return store;
}
export function updatePdfPane(moduleId: string, patch: Partial<PdfPaneState>) {
  const store = paneStore(moduleId);
  store.setState(state => ({ ...state, ...patch }));
  try { localStorage.setItem(`pdf-pane:${moduleId}`, JSON.stringify(store.state)); } catch { /* Storage may be unavailable. */ }
}
export const pdfPageRequest = createStore<{ id: string; page: number; serial: number } | null>(null);
export function requestPdfPage(id: string, page: number) { pdfPageRequest.setState(old => ({ id, page, serial: (old?.serial ?? 0) + 1 })); }
export function openPdfPane(moduleId: string, active: string) { updatePdfPane(moduleId, { open: true, active }); }
export function usePdfPane(moduleId: string) { return useSelector(paneStore(moduleId), state => state); }
