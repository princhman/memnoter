import { createStore, useSelector } from "@tanstack/react-store";
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
const targetKey = (moduleId: string) => `bank-target:${moduleId}`;
/** Where the next crop goes. Remembered per module so it survives a reload. */
export function setBankTarget(target: Target) {
  bankTarget.setState(() => target);
  try { localStorage.setItem(targetKey(target.moduleId), JSON.stringify({ questionId: target.questionId, partId: target.partId })); } catch {}
}
function storedTarget(moduleId: string): Target | null {
  try {
    const value = JSON.parse(localStorage.getItem(targetKey(moduleId)) || "null");
    return value && typeof value.questionId === "string" && typeof value.partId === "string" ? { moduleId, questionId: value.questionId, partId: value.partId } : null;
  } catch { return null; }
}
const exists = (bank: Bank, target: Target) => {
  const question = bank.questions[target.questionId];
  return !!question && !question.deleted && !!bank.revisions[question.revisionId]?.parts[target.partId];
};
/**
 * The target if it still exists (in memory, else remembered), otherwise the
 * last part of the last question: the end of the worksheet, where the next
 * crop most likely continues.
 */
export function resolveTarget(bank: Bank | null | undefined, moduleId: string, current: Target | null): Target | null {
  if (!bank) return null;
  for (const candidate of [current, storedTarget(moduleId)]) if (candidate && candidate.moduleId === moduleId && exists(bank, candidate)) return candidate;
  const last = Object.entries(bank.questions).filter(([, q]) => !q.deleted).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0])).pop();
  if (!last) return null;
  const outline = partOutline(bank.revisions[last[1].revisionId], 1);
  return { moduleId, questionId: last[0], partId: outline[outline.length - 1].id };
}
export function useBankTarget(moduleId: string, bank: Bank | null | undefined) {
  const current = useSelector(bankTarget, s => s?.moduleId === moduleId ? s : null);
  return resolveTarget(bank, moduleId, current);
}
export const bankView = createStore<string | null>(null);
export type CropDraft = Omit<WorksheetCrop, "partId" | "assetId"> & { blob: Blob; url: string };
export type BankEdit = {
  kind: "newQuestion" | "newPart" | "addCrop" | "moveCrop" | "reorderCrop" | "removeCrop" | "removePart" | "deleteQuestion" | "renameQuestion" | "moveQuestion" | "renamePart" | "movePart";
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
    setBankTarget({ moduleId, questionId: receipt.questionId, partId: receipt.partId });
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
export function partOutline(revision: WorksheetRevision, number: number | string) {
  const result: { id: string; label: string; depth: number; leaf: boolean }[] = [];
  const visit = (id: string, label: string, depth: number) => {
    const children = Object.entries(revision.parts).filter(([, p]) => p.parentId === id).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
    result.push({ id, label, depth, leaf: children.length === 0 });
    for (const [cid, part] of children) visit(cid, label + (/^\(.*\)$/.test(part.label) ? part.label : `(${part.label})`), depth + 1);
  };
  visit(revision.rootPartId, String(number), 0);
  return result;
}

export function questionLabel(title: string | undefined, number: number): string { return title?.trim() || String(number); }
