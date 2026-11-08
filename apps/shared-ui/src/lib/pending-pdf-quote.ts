import { createStore } from "@tanstack/react-store";
import type { PdfSource } from "./pdf-quote";
export type QuoteDraft = { moduleId: string; file: File; source: PdfSource; section: boolean; status: "draft" | "saving" | "error"; error?: string };
export const pendingPdfQuote = createStore<QuoteDraft | null>(null);
