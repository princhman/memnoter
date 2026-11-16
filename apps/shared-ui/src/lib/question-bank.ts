import { createStore, useSelector } from "@tanstack/react-store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { call, isNativeHost } from "./backend";
import { IS_MAC } from "./platform";
import type { WorksheetRevision, WorksheetCrop, WorksheetPin, WorksheetAnswer } from "./worksheets";
import { writeOperation, assertWritable } from "./write-lifecycle";
import { setModulePage } from "./store";

export type Bank = {
  schemaVersion: 1;
  questions: Record<string, { title: string; order: number; revisionId: string; deleted: boolean }>;
  revisions: Record<string, WorksheetRevision>;
  attempts: Record<string, { title: string; questions: WorksheetPin[]; deleted: boolean; finished?: boolean }>;
  answers: Record<string, Omit<WorksheetAnswer, "text"> & { text: string }>;
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
export type CropDraft = Omit<WorksheetCrop, "partId" | "assetId"> & { blob: Blob; url: string };
export type NestQuestionEdit = {
  kind: "nestQuestion"; questionId: string; expectedRevisionId: string;
  targetQuestionId: string; targetParentId: string; expectedTargetRevisionId: string;
  label: string; index: number;
  partId?: never; crop?: never;
};
export type BankEdit = BankEditFields & (NestQuestionEdit | {
  kind: "newQuestion" | "newPart" | "addCrop" | "replaceCrop" | "moveCrop" | "reorderCrop" | "removeCrop" | "removePart" | "deletePart" | "deleteQuestion" | "renameQuestion" | "moveQuestion" | "renamePart" | "movePart" | "reparentPart" | "transferPart" | "promotePart";
});
type BankEditFields = {
  questionId?: string; partId?: string; expectedRevisionId?: string; label?: string; title?: string;
  targetQuestionId?: string; targetParentId?: string; expectedTargetRevisionId?: string;
  cropId?: string; index?: number; crop?: Omit<CropDraft, "blob" | "url"> & { bytes: number[] };
};
export const bankKey = (moduleId: string) => ["question-bank", moduleId] as const;
export function useBankGate() {
  const supported = IS_MAC || isNativeHost();
  return useQuery({ queryKey: ["question-bank-enabled"], queryFn: () => call<boolean>("question_bank_enabled"), enabled: supported, staleTime: Infinity, retry: false }).data === true && supported;
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
    setModulePage(moduleId, "questions");
    return receipt;
  });
}
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
export type PartStyle = "lower" | "roman" | "upper" | "number";
export const PART_STYLES: { style: PartStyle; example: string }[] = [
  { style: "lower", example: "a, b, c" }, { style: "roman", example: "i, ii, iii" },
  { style: "upper", example: "A, B, C" }, { style: "number", example: "1, 2, 3" },
];
export function partStyleLabel(style: PartStyle, index: number) {
  if (style === "number") return String(index + 1);
  if (style === "roman") return ROMAN[index] ?? String(index + 1);
  const letter = String.fromCharCode(97 + (index % 26));
  return style === "upper" ? letter.toUpperCase() : letter;
}
const bare = (label: string) => label.trim().replace(/^\((.*)\)$/, "$1");
const childParts = (revision: WorksheetRevision, parentId: string) => Object.entries(revision.parts).filter(([, p]) => p.parentId === parentId)
  .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
/** The style the first child label is written in, or null for custom labels. */
export function partStyleOf(revision: WorksheetRevision, parentId: string): PartStyle | null {
  const first = childParts(revision, parentId)[0];
  if (!first) return null;
  const label = bare(first[1].label);
  if (/^\d+$/.test(label)) return "number";
  if (label === "i" || (label.length > 1 && ROMAN.includes(label))) return "roman";
  if (/^[a-z]$/.test(label)) return "lower";
  if (/^[A-Z]$/.test(label)) return "upper";
  return null;
}
/** The next label under a part: (a), (b)… then (i), (ii)… then (A), (B)…, like paper worksheets,
 *  unless the existing parts were switched to another style; new parts continue that one. */
export function nextPartLabel(revision: WorksheetRevision, parentId: string) {
  let depth = 0;
  for (let id: string | null = parentId; id && revision.parts[id]?.parentId; id = revision.parts[id].parentId) depth++;
  const style: PartStyle = partStyleOf(revision, parentId) ?? (depth % 3 === 1 ? "roman" : depth % 3 === 2 ? "upper" : "lower");
  const label = (index: number) => partStyleLabel(style, index);
  // After the last label in use, so removing (b) from (a)-(c) never gives a second (c).
  const used = new Set(childParts(revision, parentId).map(([, p]) => bare(p.label).toLowerCase()));
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

/** Allocate after every saved numeric name, including deleted questions and legacy display labels. */
export function nextQuestionLabel(bank: Bank | null | undefined): string {
  const live = Object.entries(bank?.questions ?? {}).filter(([, q]) => !q.deleted)
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  const labels = Object.values(bank?.questions ?? {}).map(q => q.title.trim());
  live.forEach(([, question], index) => { if (!question.title.trim()) labels.push(String(index + 1)); });
  let maximum = BigInt(0);
  for (const label of labels) if (/^[0-9]+$/.test(label)) {
    const number = BigInt(label);
    if (number > maximum) maximum = number;
  }
  return String(maximum + BigInt(1));
}
