import { useEffect, useState } from "react";
import * as Y from "yjs";
import { isNoteFromNewerVersion } from "./editor-schema";
import { useQueryClient } from "@tanstack/react-query";
import { call } from "./backend";
import { bankKey, refreshBankIndex, type Bank } from "./question-bank";
import { queryClient } from "./query-client";
import { assertWritable, registerFlusher, writeOperation, type WritePermit } from "./write-lifecycle";

export const answerKey = (attemptId: string, revisionId: string, leafPartId: string) => JSON.stringify([attemptId, revisionId, leafPartId]);
export type Draft = { revisionId: string; leafPartId: string; text: string; document?: number[]; expected?: string; hasContent?: boolean };
export type AnswerDocument = { document: number[]; expected: string; plainText: string | null };
type Snapshot = { values: Record<string, Draft>; drafts: Record<string, Draft>; saving: boolean; error: string; backupError: string; errors: Record<string, string>; resets: Record<string, number> };
type Session = { moduleId: string; attemptId: string; snapshot: Snapshot; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>; running?: Promise<void> };
const sessions = new Map<string, Session>();
const storageKey = (moduleId: string, attemptId: string) => `worksheet-drafts:${JSON.stringify([moduleId, attemptId])}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function sessionFor(moduleId: string, attemptId: string): Session {
  const key = storageKey(moduleId, attemptId);
  let session = sessions.get(key);
  if (!session) {
    let drafts: Record<string, Draft> = {};
    let backupError = "";
    try {
      const stored = JSON.parse(localStorage.getItem(key) || "{}");
      for (const [id, value] of Object.entries(stored)) {
        const draft = value as Draft;
        if (draft && typeof draft.revisionId === "string" && typeof draft.leafPartId === "string" && typeof draft.text === "string" && (!draft.document || (Array.isArray(draft.document) && draft.document.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) && typeof draft.expected === "string")) && id === answerKey(attemptId, draft.revisionId, draft.leafPartId)) drafts[id] = draft;
      }
    } catch { backupError = "Could not read local answer backups. Keep this window open until answers are saved."; }
    session = { moduleId, attemptId, snapshot: { values: { ...drafts }, drafts, saving: false, error: "", backupError, errors: {}, resets: {} }, listeners: new Set() };
    sessions.set(key, session);
  }
  return session;
}
function publish(session: Session, patch: Partial<Snapshot>) {
  session.snapshot = { ...session.snapshot, ...patch };
  session.listeners.forEach(listener => listener());
}
function backup(session: Session) {
  try {
    const key = storageKey(session.moduleId, session.attemptId);
    if (Object.keys(session.snapshot.drafts).length) localStorage.setItem(key, JSON.stringify(session.snapshot.drafts));
    else localStorage.removeItem(key);
    publish(session, { backupError: "" });
  } catch { publish(session, { backupError: "Local backup unavailable. Keep this window open until answers are saved." }); }
}
// A session outlives its view. Navigation cannot drop the last debounce or let an
// old response replace newer input. Only this command's answer enters the cache.
function flush(session: Session, permit?: WritePermit): Promise<void> {
  if (session.timer) clearTimeout(session.timer);
  session.timer = undefined;
  if (session.running) return session.running;
  if (!Object.values(session.snapshot.drafts).some(draft => draft.document)) return Promise.resolve();
  session.running = Promise.resolve().then(async () => {
    publish(session, { saving: true, error: "" });
    const failed = new Set<string>();
    const errors = { ...session.snapshot.errors };
    try {
      while (Object.entries(session.snapshot.drafts).some(([key, draft]) => draft.document && !failed.has(key))) {
        const [key, draft] = Object.entries(session.snapshot.drafts).find(([key, draft]) => draft.document && !failed.has(key))!;
        try {
          const inspection = new Y.Doc();
          try {
            Y.applyUpdate(inspection, new Uint8Array(draft.document!));
            if (isNoteFromNewerVersion(inspection)) throw new Error("This local answer draft requires a newer app version. It is retained unchanged.");
          } finally { inspection.destroy(); }
          const save = async (permit?: WritePermit) => {
            assertWritable(permit);
            return call<{ bank: Bank; expected: string }>("worksheet_answer_document_save", { moduleId: session.moduleId, attemptId: session.attemptId, revisionId: draft.revisionId, leafPartId: draft.leafPartId, document: draft.document, expected: draft.expected });
          };
          const receipt = await (permit ? save(permit) : writeOperation(save));
          delete errors[key];
          const answer = receipt.bank.answers[key];
          if (!answer || typeof receipt.expected !== "string") throw new Error("The server did not acknowledge the answer text. Your draft is retained.");
          queryClient.setQueryData<Bank | null>(bankKey(session.moduleId), current => current ? { ...current, answers: { ...current.answers, [key]: current.answers[key] ? { ...current.answers[key], text: answer.text } : answer } } : receipt.bank);
          if (session.snapshot.drafts[key] === draft) {
            const drafts = { ...session.snapshot.drafts }; delete drafts[key];
            publish(session, { drafts, values: { ...session.snapshot.values, [key]: { ...draft, expected: receipt.expected } } }); backup(session);
          } else if (session.snapshot.drafts[key]) {
            // An ack advances the base of newer input, never clears it.
            const newer = { ...session.snapshot.drafts[key], expected: receipt.expected };
            publish(session, { drafts: { ...session.snapshot.drafts, [key]: newer }, values: { ...session.snapshot.values, [key]: newer } }); backup(session);
          }
        } catch (error) { failed.add(key); errors[key] = message(error); }
      }
    } catch (error) { publish(session, { error: message(error) }); }
    finally { session.running = undefined; publish(session, { saving: false, errors, error: Object.values(errors)[0] || "" }); }
  });
  return session.running;
}
/** Navigation drains admitted saves; failed drafts remain available for recovery. */
export async function flushWorksheetAnswers() {
  await Promise.all([...sessions.values()].map(session => flush(session)));
}
// Database lifecycle barriers must fail rather than silently omit an unsaved answer.
registerFlusher("worksheet-answers", async permit => {
  await Promise.all([...sessions.values()].map(session => flush(session, permit)));
  for (const session of sessions.values()) {
    if (Object.keys(session.snapshot.drafts).length) throw new Error(session.snapshot.error || "Worksheet answers could not be saved. Your drafts are retained.");
  }
}, flushWorksheetAnswers);

export function useWorksheetAnswers(moduleId: string, attemptId: string) {
  const session = sessionFor(moduleId, attemptId);
  const [, update] = useState(0);
  useEffect(() => {
    const listener = () => update(value => value + 1);
    session.listeners.add(listener);
    if (Object.keys(session.snapshot.drafts).length) void flush(session);
    return () => { session.listeners.delete(listener); void flush(session); };
  }, [session]);
  return {
    ...session.snapshot,
    async loadDocument(revisionId: string, leafPartId: string): Promise<AnswerDocument & { legacyDraft?: string }> {
      const loaded = await call<AnswerDocument>("worksheet_answer_document_load", { moduleId, attemptId, revisionId, leafPartId });
      const key = answerKey(attemptId, revisionId, leafPartId);
      const draft = session.snapshot.drafts[key];
      if (draft?.document) return { document: draft.document, expected: draft.expected!, plainText: null };
      if (draft) {
        if (loaded.plainText === null) {
          const error = "A plain-text local draft conflicts with a rich answer. Retry to reapply your local text, or Discard to use the saved answer.";
          publish(session, { errors: { ...session.snapshot.errors, [key]: error }, error });
          throw new Error(error);
        }
        return { ...loaded, legacyDraft: draft.text };
      }
      // A clean reopen uses the fresh server base, not an old acknowledged view.
      const values = { ...session.snapshot.values }; delete values[key];
      publish(session, { values });
      return loaded;
    },
    async refreshDocument(revisionId: string, leafPartId: string, expected: string, isCurrent: () => boolean, apply: (loaded: AnswerDocument) => void) {
      const key = answerKey(attemptId, revisionId, leafPartId);
      if (session.snapshot.drafts[key]) return false;
      const value = session.snapshot.values[key];
      const loaded = await call<AnswerDocument>("worksheet_answer_document_load", { moduleId, attemptId, revisionId, leafPartId });
      // Typing or a save acknowledgement may race the backend read.
      if (!isCurrent() || session.snapshot.drafts[key] || session.snapshot.values[key] !== value) return false;
      if (loaded.expected === (value?.expected ?? expected)) return true;
      const values = { ...session.snapshot.values }; delete values[key];
      publish(session, { values });
      apply(loaded);
      return true;
    },
    setDocument(revisionId: string, leafPartId: string, document: number[], expected: string, text: string, hasContent: boolean) {
      const key = answerKey(attemptId, revisionId, leafPartId);
      // Prefer the last ack's base when this mounted editor still has an old base.
      const base = session.snapshot.values[key]?.expected ?? expected;
      const draft = { revisionId, leafPartId, text, document, expected: base, hasContent };
      publish(session, { values: { ...session.snapshot.values, [key]: draft }, drafts: { ...session.snapshot.drafts, [key]: draft } });
      backup(session);
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => { void flush(session); }, 500);
    },
    async retryAnswer(revisionId: string, leafPartId: string, confirmedBase?: string) {
      const key = answerKey(attemptId, revisionId, leafPartId);
      const draft = session.snapshot.drafts[key];
      if (!draft) return;
      if (draft.document && confirmedBase === undefined) {
        // Retrying with the original base also recovers a lost save receipt.
        await flush(session);
        if (session.snapshot.drafts[key] !== draft) return;
      }
      try {
        const loaded = await call<AnswerDocument>("worksheet_answer_document_load", { moduleId, attemptId, revisionId, leafPartId });
        if (session.snapshot.drafts[key] !== draft) return;
        const conflict = draft.document ? loaded.expected !== draft.expected : loaded.plainText === null;
        if (conflict && loaded.expected !== confirmedBase) return loaded.expected;
        if (!conflict && draft.document) return; // The retry failed for another reason.
        let document = draft.document;
        if (!document) {
          const local = new Y.Doc();
          const paragraph = new Y.XmlElement("paragraph");
          local.getXmlFragment("default").insert(0, [paragraph]);
          if (draft.text) { const text = new Y.XmlText(); paragraph.insert(0, [text]); text.insert(0, draft.text); }
          document = Array.from(Y.encodeStateAsUpdate(local));
          local.destroy();
        }
        const next = { ...draft, document, expected: loaded.expected };
        publish(session, { drafts: { ...session.snapshot.drafts, [key]: next }, values: { ...session.snapshot.values, [key]: next } });
        backup(session);
        await flush(session);
      } catch (error) { publish(session, { errors: { ...session.snapshot.errors, [key]: message(error) }, error: message(error) }); }
    },
    discardAnswer(revisionId: string, leafPartId: string) {
      if (session.running) return;
      const key = answerKey(attemptId, revisionId, leafPartId);
      const drafts = { ...session.snapshot.drafts }; delete drafts[key];
      const values = { ...session.snapshot.values }; delete values[key];
      const errors = { ...session.snapshot.errors }; delete errors[key];
      publish(session, { drafts, values, errors, error: Object.values(errors)[0] || "", resets: { ...session.snapshot.resets, [key]: (session.snapshot.resets[key] || 0) + 1 } });
      backup(session);
    },
    finish: async () => {
      await flush(session);
      if (Object.keys(session.snapshot.drafts).length) throw new Error(session.snapshot.error || "Save all answers before finishing.");
      await writeOperation(async permit => {
        assertWritable(permit);
        const receipt = await call<{ bank: Bank }>("worksheet_attempt_finish", { moduleId, attemptId });
        queryClient.setQueryData<Bank | null>(bankKey(moduleId), current => current ? { ...current, attempts: { ...current.attempts, [attemptId]: receipt.bank.attempts[attemptId] } } : receipt.bank);
      });
    },
    flush: () => flush(session),
    flushDurable: async (revisionId: string, leafPartId: string) => {
      await flush(session);
      if (session.snapshot.drafts[answerKey(attemptId, revisionId, leafPartId)]) throw new Error(session.snapshot.error || "The answer is not saved yet. Your drawing draft is retained.");
    },
  };
}
export function useCreateWorksheet(moduleId: string) {
  const client = useQueryClient();
  return (title: string, questionIds: string[]) => writeOperation(async permit => {
    assertWritable(permit);
    const receipt = await call<{ bank: Bank; attemptId: string }>("worksheet_attempt_create", { moduleId, title, questionIds });
    client.setQueryData<Bank | null>(bankKey(moduleId), current => current ? {
      ...current,
      revisions: { ...receipt.bank.revisions, ...current.revisions },
      attempts: { ...current.attempts, [receipt.attemptId]: receipt.bank.attempts[receipt.attemptId] },
    } : receipt.bank);
    void refreshBankIndex(moduleId);
    return receipt.attemptId;
  });
}
