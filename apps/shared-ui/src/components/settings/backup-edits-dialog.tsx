import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createStore, useSelector } from "@tanstack/react-store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useActiveEditor } from "@/lib/active-editor-context";
import { applyBackupHunks, buildBackupReview, readBackupEdits, recheckBackupFile, type BackupReviewFile } from "@/lib/backup-edit-review";
import { localBackupSettings } from "@/lib/local-backup";
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

function rememberEdits(folder: string, files: Awaited<ReturnType<typeof readBackupEdits>>) {
  const hashes = new Map(files.map(file => [file.path, file.hash]));
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
  if (shownEdits(folder) === shown) rememberEdits(folder, edited);
  toast.dismiss(toastId);
  backupReview.setState(() => ({ folder, files }));
}

export async function notifyOfBackupEdits(folder: string, isActive: () => boolean) {
  const edited = await readBackupEdits(folder);
  if (!isActive()) return;
  const shown = shownEdits(folder);
  const fresh = edited.filter(file => shown.get(file.path) !== file.hash);
  if (fresh.length || shown.size !== edited.length) rememberEdits(folder, edited);
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
  const [pending, setPending] = useState<NoteFile | null>(null);
  const [busy, setBusy] = useState(false);
  const appliedEditor = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const { activeEditor } = useActiveEditor();
  const close = () => backupReview.setState(() => null);

  async function apply(note: NoteFile) {
    setError(null);
    setBusy(true);
    try {
      await recheckBackupFile(folder, note);
      await navigate({ to: "/$moduleId", params: { moduleId: note.moduleId } });
      setPending(note);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!pending || activeEditor?.moduleId !== pending.moduleId ||
      (!activeEditor.isReady && !activeEditor.loadError)) return;
    setPending(null);
    setBusy(false);
    try {
      if (activeEditor.loadError) throw activeEditor.loadError;
      applyBackupHunks(activeEditor.editor, pending, applicableHunks(pending));
      appliedEditor.current = activeEditor.editor.view.dom;
      if (remaining.length <= 1) {
        const editor = appliedEditor.current;
        close();
        requestAnimationFrame(() => editor.focus({ preventScroll: true }));
      } else {
        setFinished(current => [...current, pending.path]);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [pending, activeEditor, remaining.length]);

  function keep(path: string) {
    setError(null);
    if (remaining.length === 1) close();
    else setFinished(current => [...current, path]);
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy} finalFocus={() => appliedEditor.current ?? true}>
        <DialogHeader className="pr-8">
          <DialogTitle>Backup edits</DialogTitle>
          <DialogDescription>
            {remaining.length ? "Apply eligible edits to their notes, or keep them in the backup only." : "No edits found in the backup."}
          </DialogDescription>
        </DialogHeader>
        {remaining.length > 0 && (
          <ul aria-label="Edited files" className="flex max-h-[min(60vh,36rem)] min-h-0 flex-col gap-3 overflow-y-auto">
            {remaining.map(file => {
              const applicable = file.kind === "note" ? applicableHunks(file).length : 0;
              const status = file.kind === "read-only" ? file.reason
                : !file.hunks.length ? "The Markdown content already matches the note."
                : !applicable ? "These edits cannot be safely applied."
                : applicable < file.hunks.length ? "Only safe edits will be applied." : null;
              return (
                <li key={file.path} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1 basis-48">
                    {file.title !== file.path && <div className="break-words font-medium">{file.title}</div>}
                    <div className="wrap-anywhere text-sm">{file.path}</div>
                    {status && <p className="text-xs text-muted-foreground">{status}</p>}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" aria-label={`Keep ${file.path}`} disabled={busy}
                      onClick={() => keep(file.path)}>Keep</Button>
                    {file.kind === "note" && applicable > 0 && (
                      <Button size="sm" aria-label={`Apply ${file.path}`} disabled={busy}
                        onClick={() => void apply(file)}>Apply</Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

function applicableHunks(note: NoteFile) {
  return note.hunks.flatMap((hunk, index) => hunk.reason ? [] : [index]);
}
