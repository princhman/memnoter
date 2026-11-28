import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createStore, useSelector } from "@tanstack/react-store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useActiveEditor } from "@/lib/active-editor-context";
import { applyBackupHunks, buildBackupReview, readBackupEdits, recheckBackupFiles, type BackupReviewFile } from "@/lib/backup-edit-review";
import { localBackupSettings, resolveBackupFiles } from "@/lib/local-backup";
import { queryClient } from "@/lib/query-client";

const backupReview = createStore<{ folder: string; files: BackupReviewFile[] } | null>(null);
const toastId = "local-backup-edits";
const shownByFolder = new Map<string, Map<string, string>>();

function shownEdits(folder: string) {
  const cached = shownByFolder.get(folder);
  if (cached) return cached;
  const hashes = new Map<string, string>();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`local-backup-edits:${folder}`) ?? "{}");
    if (saved && typeof saved === "object") {
      for (const [path, hash] of Object.entries(saved)) {
        if (typeof hash === "string") hashes.set(path, hash);
      }
    }
  } catch { /* Keep tracking edits in this session if storage is unavailable. */ }
  shownByFolder.set(folder, hashes);
  return hashes;
}

function rememberEdits(folder: string, hashes: Map<string, string>) {
  shownByFolder.set(folder, hashes);
  try {
    localStorage.setItem(`local-backup-edits:${folder}`, JSON.stringify(Object.fromEntries(hashes)));
  } catch { /* The in-memory hashes still suppress repeated notices. */ }
}

export async function openBackupEdits(folder: string) {
  const shown = shownEdits(folder);
  const edited = await readBackupEdits(folder);
  const files = await buildBackupReview(edited);
  if (queryClient.getQueryData(localBackupSettings.queryKey)?.folder !== folder || backupReview.state) return;
  if (shownEdits(folder) === shown) rememberEdits(folder, new Map(edited.map(file => [file.path, file.hash])));
  toast.dismiss(toastId);
  backupReview.setState(() => ({ folder, files }));
}

export async function notifyOfBackupEdits(folder: string, isActive: () => boolean) {
  const edited = await readBackupEdits(folder);
  if (!isActive()) return;
  const shown = shownEdits(folder);
  const fresh = edited.filter(file => shown.get(file.path) !== file.hash);
  if (fresh.length || shown.size !== edited.length) rememberEdits(folder, new Map(edited.map(file => [file.path, file.hash])));
  if (!edited.length) toast.dismiss(toastId);
  if (!fresh.length) return;

  toast(`Edits found in the backup: ${fresh.length} file${fresh.length === 1 ? "" : "s"}`, {
    id: toastId,
    closeButton: true,
    duration: 8000,
    action: {
      label: "Review",
      onClick: () => {
        if (isActive()) void openBackupEdits(folder).catch(error => {
          toast.error(error instanceof Error ? error.message : "Could not review the backup edits.");
        });
      },
    },
  });
}

type NoteFile = Extract<BackupReviewFile, { kind: "note" }>;

export function BackupEditsDialog() {
  const review = useSelector(backupReview, state => state);
  return review && <Review {...review} />;
}

function Review({ folder, files }: { folder: string; files: BackupReviewFile[] }) {
  const [finished, setFinished] = useState<string[]>([]);
  const remaining = files.filter(file => !finished.includes(file.path));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<NoteFile[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const appliedEditor = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const { activeEditor } = useActiveEditor();
  const close = () => backupReview.setState(() => null);

  async function apply(notes: NoteFile[]) {
    setError(null);
    setBusy(true);
    try {
      await navigate({ to: "/$moduleId", params: { moduleId: notes[0].moduleId } });
      setPending(notes);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  async function updateBackup(selected: readonly BackupReviewFile[], afterApply = false) {
    setError(null);
    setBusy(true);
    try {
      const results = await resolveBackupFiles(folder, selected);
      const resolved = results.filter(result => result.error === null).map(result => result.path);
      const problems = results.flatMap(result => result.error ? [`${result.path}\n${result.error}`] : []);
      if (resolved.length) {
        const shown = new Map(shownEdits(folder));
        for (const path of resolved) shown.delete(path);
        rememberEdits(folder, shown);
        toast.dismiss(toastId);
      }
      setFinished(current => [...current, ...resolved]);
      if (problems.length) {
        setError((afterApply ? "Note edits applied. " : "") + problems.join("\n"));
      } else if (remaining.every(file => resolved.includes(file.path))) {
        const editor = appliedEditor.current;
        close();
        if (editor) requestAnimationFrame(() => editor.focus({ preventScroll: true }));
      }
    } catch (error) {
      setError((afterApply ? "Note edits applied. " : "") + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  useEffect(() => {
    if (!pending || activeEditor?.moduleId !== pending[0].moduleId ||
      (!activeEditor.isReady && !activeEditor.loadError)) return;
    setPending(null);
    const editor = activeEditor;
    void (async () => {
      try {
        if (editor.loadError) throw editor.loadError;
        await recheckBackupFiles(folder, pending);
        applyBackupHunks(editor.editor, pending);
        appliedEditor.current = editor.editor.view.dom;
        setApplied(current => [...current, ...pending.map(file => file.path)]);
        await updateBackup(pending, true);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        setBusy(false);
      }
    })();
  }, [pending, activeEditor]);

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy} finalFocus={() => appliedEditor.current ?? true}>
        <DialogHeader className="pr-8">
          <DialogTitle>Backup edits</DialogTitle>
          <DialogDescription>
            {remaining.length ? "Apply safe edits to Memnoter or reset the backup file to match your notes." : "No edits found in the backup."}
          </DialogDescription>
        </DialogHeader>
        {remaining.length > 0 && (
          <ul aria-label="Edited files" className="flex max-h-[min(60vh,36rem)] min-h-0 flex-col gap-3 overflow-y-auto">
            {remaining.map(file => {
              const alreadyApplied = applied.includes(file.path);
              const applicable = file.kind === "note" && !alreadyApplied ? applicableCount(file) : 0;
              const section = file.kind === "note" ? file.input.section : undefined;
              const batch = file.kind !== "note" || !applicable ? []
                : section ? remaining.filter((candidate): candidate is NoteFile =>
                  candidate.kind === "note" && candidate.moduleId === file.moduleId &&
                  candidate.input.section?.revision === section.revision && !applied.includes(candidate.path) && applicableCount(candidate) > 0)
                : [file];
              const status = alreadyApplied ? "Note edits applied. The backup still needs updating."
                : file.kind === "read-only" ? file.reason
                : !file.hunks.length ? "The Markdown content already matches the note."
                : !applicable ? "These edits cannot be safely applied."
                : applicable < file.hunks.length ? "Apply saves safe edits and replaces the backup file. Other edits in this file will be discarded." : null;
              return (
                <li key={file.path} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1 basis-48">
                    {file.title !== file.path && <div className="break-words font-medium">{file.title}</div>}
                    <div className="wrap-anywhere text-sm">{file.path}</div>
                    {status && <p className="text-xs text-muted-foreground">{status}</p>}
                  </div>
                  <div className="flex gap-1">
                    {alreadyApplied ? (
                      <Button size="sm" variant="outline" disabled={busy || confirming !== null}
                        onClick={() => void updateBackup([file], true)}>Retry backup update</Button>
                    ) : (
                      <Button size="sm" variant="ghost" aria-label={`Reset backup ${file.path}`}
                        disabled={busy || confirming !== null} onClick={() => setConfirming(file.path)}>
                        Reset backup
                      </Button>
                    )}
                    {batch[0] === file && (
                      <Button size="sm"
                        aria-label={batch.length === 1 ? `Apply ${file.path}` : `Apply all ${batch.length} files for ${file.title}`}
                        disabled={busy || confirming !== null} onClick={() => void apply(batch)}>
                        {batch.length === 1 ? "Apply" : `Apply all ${batch.length}`}
                      </Button>
                    )}
                  </div>
                  {confirming === file.path && (
                    <div className="flex w-full flex-wrap items-center justify-end gap-2 pt-1">
                      <p className="min-w-48 flex-1 text-xs text-muted-foreground">
                        Discard edits to this file? Memnoter will replace it or remove it if it no longer belongs in the backup.
                      </p>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
                      <Button size="sm" variant="destructive" disabled={busy}
                        onClick={() => void updateBackup([file])}>Confirm reset</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && <p role="alert" className="whitespace-pre-line text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

function applicableCount(note: NoteFile) {
  return note.hunks.filter(hunk => !hunk.reason).length;
}
