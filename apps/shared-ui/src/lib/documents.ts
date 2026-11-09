import { call } from "./backend";

export interface DocumentRecord {
  id: string;
  moduleId: string;
  moduleName: string;
  name: string;
  size: number;
  pageCount: number | null;
  createdAt: number;
  available: boolean;
}

export const addDocument = (args: { moduleId: string; path: string }) =>
  call<DocumentRecord>("add_document", args);
export const addDocumentBytes = (args: { moduleId: string; name: string; bytes: number[] }) =>
  call<DocumentRecord>("add_document_bytes", args);
export const listDocuments = (args: { moduleId?: string } = {}) =>
  call<DocumentRecord[]>("list_documents", args);
export const renameDocument = (args: { id: string; name: string }) =>
  call<void>("rename_document", args);
export const setDocumentPageCount = (args: { id: string; pageCount: number }) =>
  call<void>("set_document_page_count", args);
export const deleteDocument = (args: { id: string }) =>
  call<void>("delete_document", args);
export const documentPath = (args: { id: string }) =>
  call<string>("document_path", args);
