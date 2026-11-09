import { createStore } from "@tanstack/react-store";
import type { PdfSource } from "./pdf-quote";

export type PdfTextQuotePart = { text: string; source: PdfSource };
export type QuoteDraft = {
  id: string;
  moduleId: string;
  status: "draft" | "saving" | "error";
  error?: string;
} & (
  | { kind: "image"; file: File; source: PdfSource }
  | { kind: "text"; parts: readonly PdfTextQuotePart[] }
);
export const pendingPdfQuote = createStore<QuoteDraft | null>(null);
