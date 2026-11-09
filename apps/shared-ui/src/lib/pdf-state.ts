import { isNativeHost, postNativeEvent } from "./backend";
export const documentName = (name: string) => name.replace(/\.pdf$/i, "");
export function parsePage(value: string, count: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= count ? page : null;
}
export function visiblePages(heights: number[], top: number, height: number) {
  let offset = 0;
  const visible: number[] = [];
  heights.forEach((size, index) => {
    if (offset + size >= top && offset <= top + height) visible.push(index);
    offset += size;
  });
  if (!visible.length) return [];
  return Array.from({ length: Math.min(heights.length - 1, visible[visible.length - 1] + 1) - Math.max(0, visible[0] - 1) + 1 }, (_, i) => Math.max(0, visible[0] - 1) + i);
}
export function parsePdfView(value: unknown) {
  if (typeof value !== "object" || value === null) return { page: 1, zoom: 1 };
  return {
    page: "page" in value && typeof value.page === "number" && Number.isSafeInteger(value.page) && value.page > 0 ? value.page : 1,
    zoom: "zoom" in value && typeof value.zoom === "number" && Number.isFinite(value.zoom) ? Math.max(0.25, Math.min(3, value.zoom)) : 1,
  };
}
declare global {
  interface Window { __memnoterPdfViewState?: Record<string, unknown>; }
}
export function readPdfView(id: string) {
  if (isNativeHost() && window.__memnoterPdfViewState?.[id] !== undefined) return parsePdfView(window.__memnoterPdfViewState[id]);
  try { return parsePdfView(JSON.parse(localStorage.getItem(`pdf-view:${id}`) ?? "null")); }
  catch { return parsePdfView(null); }
}

export function writePdfView(id: string, view: { page: number; zoom: number }) {
  const value = parsePdfView(view);
  try { localStorage.setItem(`pdf-view:${id}`, JSON.stringify(value)); } catch { /* Native hosts also persist through UserDefaults. */ }
  if (isNativeHost()) {
    (window.__memnoterPdfViewState ??= {})[id] = value;
    postNativeEvent("pdfViewState", { documentId: id, ...value });
  }
}

export type PdfPaneState = { open: boolean; width: number; active: string | null };
export function parsePdfPane(value: unknown): PdfPaneState {
  if (typeof value !== "object" || value === null) return { open: false, width: 420, active: null };
  return {
    open: "open" in value && value.open === true,
    width: "width" in value && typeof value.width === "number" && Number.isFinite(value.width) ? Math.max(320, Math.min(1000, value.width)) : 420,
    active: "active" in value && typeof value.active === "string" ? value.active : null,
  };
}
