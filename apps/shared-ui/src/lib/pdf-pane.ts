import { createStore, useSelector } from "@tanstack/react-store";
import { windowViewStorage } from "./backend";
import { parsePdfPane, type PdfPaneState } from "./pdf-state";
function readPane(moduleId: string): PdfPaneState {
  try { return parsePdfPane(JSON.parse(windowViewStorage().getItem(`pdf-pane:${moduleId}`) ?? "null")); }
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
  try { windowViewStorage().setItem(`pdf-pane:${moduleId}`, JSON.stringify(store.state)); } catch { /* Storage may be unavailable. */ }
}
export const pdfPageRequest = createStore<{ id: string; page: number; serial: number } | null>(null);
export function requestPdfPage(id: string, page: number) { pdfPageRequest.setState(old => ({ id, page, serial: (old?.serial ?? 0) + 1 })); }
export function openPdfPane(moduleId: string, active: string) { updatePdfPane(moduleId, { open: true, active }); }
// Track open attempts independently of whether their surface is visible.
const worksheetModules = createStore<readonly string[]>([]);
export function setWorksheetOpen(moduleId: string, open: boolean) {
  worksheetModules.setState(list => open ? (list.includes(moduleId) ? list : [...list, moduleId]) : list.filter(id => id !== moduleId));
}
export function useAnyWorksheetOpen() { return useSelector(worksheetModules, list => list[0] ?? null); }
// Root header slots a desktop worksheet portals its back/title and controls into.
export const WORKSHEET_CRUMB_SLOT = "worksheet-crumb-slot";
export const WORKSHEET_ACTIONS_SLOT = "worksheet-actions-slot";
export function useWorksheetOpen(moduleId: string) { return useSelector(worksheetModules, list => list.includes(moduleId)); }
export function usePdfPane(moduleId: string, { worksheetSurfaceVisible = true } = {}) {
  const pane = useSelector(paneStore(moduleId), state => state);
  const worksheet = useWorksheetOpen(moduleId);
  return worksheetSurfaceVisible && worksheet && pane.open ? { ...pane, open: false } : pane;
}
