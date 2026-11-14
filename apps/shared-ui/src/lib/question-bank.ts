import { createStore } from "@tanstack/react-store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./backend";
import { IS_MAC } from "./platform";
import type { WorksheetRevision, WorksheetCrop } from "./worksheets";
import { writeOperation, assertWritable } from "./write-lifecycle";

export type Bank = {
  schemaVersion: 1;
  questions: Record<string, { title: string; order: number; revisionId: string; deleted: boolean }>;
  revisions: Record<string, WorksheetRevision>;
};
export type Target = { moduleId: string; questionId: string; partId: string };
export const bankTarget = createStore<Target | null>(null);
export const bankView = createStore<string | null>(null);
export type CropDraft = Omit<WorksheetCrop, "partId" | "assetId"> & { blob: Blob; url: string };
export type BankEdit = {
  kind: "newQuestion" | "newPart" | "addCrop" | "moveCrop" | "reorderCrop" | "removeCrop" | "removePart" | "deleteQuestion";
  questionId?: string; partId?: string; expectedRevisionId?: string; label?: string; title?: string;
  cropId?: string; index?: number; crop?: Omit<CropDraft, "blob" | "url"> & { bytes: number[] };
};
export const bankKey = (moduleId: string) => ["question-bank", moduleId] as const;
export function useBankGate() {
  return useQuery({ queryKey: ["question-bank-enabled"], queryFn: () => call<boolean>("question_bank_enabled"), enabled: IS_MAC, staleTime: Infinity, retry: false }).data === true && IS_MAC;
}
export function useBank(moduleId: string, enabled: boolean) {
  return useQuery({ queryKey: bankKey(moduleId), queryFn: () => call<Bank | null>("question_bank_get", { moduleId }), enabled, retry: false });
}
export function useBankEdit(moduleId: string) {
  const client = useQueryClient();
  return async (edit: BankEdit) => writeOperation(async permit => {
    assertWritable(permit);
    const receipt = await call<{ bank: Bank; questionId: string; partId: string }>("question_bank_edit", { moduleId, edit });
    client.setQueryData(bankKey(moduleId), receipt.bank);
    bankTarget.setState(() => ({ moduleId, questionId: receipt.questionId, partId: receipt.partId }));
    bankView.setState(() => moduleId);
    return receipt;
  });
}
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
/** The next label under a part: (a), (b)… then (i), (ii)… then (A), (B)…, like paper worksheets. */
export function nextPartLabel(revision: WorksheetRevision, parentId: string) {
  let depth = 0;
  for (let id: string | null = parentId; id && revision.parts[id]?.parentId; id = revision.parts[id].parentId) depth++;
  const label = (index: number) => {
    if (depth % 3 === 1) return ROMAN[index] ?? String(index + 1);
    const letter = String.fromCharCode(97 + (index % 26));
    return depth % 3 === 2 ? letter.toUpperCase() : letter;
  };
  // After the last label in use, so removing (b) from (a)-(c) never gives a second (c).
  const used = new Set(Object.values(revision.parts).filter(p => p.parentId === parentId).map(p => p.label.replace(/^\((.*)\)$/, "$1").toLowerCase()));
  let next = 0;
  for (let index = 0; index < 52; index++) if (used.has(label(index).toLowerCase())) next = index + 1;
  return label(next);
}
export function partOutline(revision: WorksheetRevision, number: number) {
  const result: { id: string; label: string; depth: number; leaf: boolean }[] = [];
  const visit = (id: string, label: string, depth: number) => {
    const children = Object.entries(revision.parts).filter(([, p]) => p.parentId === id).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
    result.push({ id, label, depth, leaf: children.length === 0 });
    for (const [cid, part] of children) visit(cid, label + (/^\(.*\)$/.test(part.label) ? part.label : `(${part.label})`), depth + 1);
  };
  visit(revision.rootPartId, String(number), 0);
  return result;
}
