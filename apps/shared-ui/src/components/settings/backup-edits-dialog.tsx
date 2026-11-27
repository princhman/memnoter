import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createStore, useSelector } from "@tanstack/react-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useActiveEditor } from "@/lib/active-editor-context";
import { applyBackupHunks, recheckBackupFile, type BackupReviewFile } from "@/lib/backup-edit-review";
import { cn } from "@/lib/utils";

export const backupReview = createStore<{ folder: string; files: BackupReviewFile[] } | null>(null);
type NoteFile = Extract<BackupReviewFile, { kind: "note" }>;

export function BackupEditsDialog() {
  const review = useSelector(backupReview, state => state);
  return review && <Review {...review} />;
}

function Review({ folder, files }: { folder: string; files: BackupReviewFile[] }) {
  const [finished, setFinished] = useState<string[]>([]);
  const remaining = files.filter(file => !finished.includes(file.path));
  const [path, setPath] = useState((files.find(file => file.kind === "note") ?? files[0])?.path);
  const diffId = useId();
  const [selections, setSelections] = useState<Record<string, number[]>>({});
  const file = remaining.find(file => file.path === path) ?? remaining[0];
  const selected = selections[file?.path] ?? [];
  const setSelected = (indexes: number[]) => setSelections(values => ({ ...values, [file.path]: indexes }));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ note: NoteFile; selected: number[] } | null>(null);
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
      setPending({ note, selected });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!pending || activeEditor?.moduleId !== pending.note.moduleId ||
      (!activeEditor.isReady && !activeEditor.loadError)) return;
    setPending(null);
    setBusy(false);
    try {
      if (activeEditor.loadError) throw activeEditor.loadError;
      applyBackupHunks(activeEditor.editor, pending.note, pending.selected);
      appliedEditor.current = activeEditor.editor.view.dom;
      if (remaining.length <= 1) {
        const editor = appliedEditor.current;
        close();
        requestAnimationFrame(() => editor.focus({ preventScroll: true }));
      } else {
        setFinished(current => [...current, pending.note.path]);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [pending, activeEditor, remaining.length]);

  const hunks = file?.kind === "note" ? file.hunks : [];
  const applicable = hunks.flatMap((hunk, index) => hunk.reason ? [] : [index]);
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={!busy} finalFocus={() => appliedEditor.current ?? true}>
        <DialogHeader className="pr-8">
          <DialogTitle>Backup edits</DialogTitle>
          <DialogDescription>
            {file ? "Choose which changes to bring into the note." : "No edits found in the backup."}
          </DialogDescription>
        </DialogHeader>
        {file && (
          <div className="grid max-h-[min(60vh,36rem)] min-h-0 gap-3 overflow-y-auto sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:overflow-hidden">
            <nav aria-label="Edited files" className="flex min-h-0 flex-col gap-1 overflow-y-auto">
              {remaining.map(item => (
                <button key={item.path} type="button" aria-current={item.path === file.path} disabled={busy}
                  className={cn("w-full rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground",
                    item.path === file.path && "bg-accent text-accent-foreground")}
                  onClick={() => { setPath(item.path); setError(null); }}>
                  <span className="block truncate">{item.title}</span>
                  {item.title !== item.path && (item.kind === "read-only" || files.some(other => other !== item && other.title === item.title)) &&
                    <span className="block break-all text-xs opacity-75">{item.path}</span>}
                </button>
              ))}
            </nav>
            <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
              {file.kind === "read-only" && <p className="px-2 text-muted-foreground">{file.reason}</p>}
              {file.kind === "note" && !hunks.length && <p className="px-2 text-muted-foreground">The Markdown content already matches the note.</p>}
              {hunks.map((hunk, index) => (
                <div key={index} className="space-y-1.5 px-2">
                  <div id={`${diffId}-${index}`} className="space-y-1.5">
                    {hunk.before && <div className="rounded-md bg-red-500/10 px-2 py-1 dark:bg-red-400/15">
                      <span className="text-xs font-medium">Current note</span>
                      <div className="whitespace-pre-wrap">{hunk.before}</div>
                    </div>}
                    {hunk.after && <div className="rounded-md bg-emerald-500/10 px-2 py-1 dark:bg-emerald-400/15">
                      <span className="text-xs font-medium">Backup file</span>
                      <div className="whitespace-pre-wrap">{hunk.after}</div>
                    </div>}
                  </div>
                  {hunk.reason ? <p className="text-xs text-muted-foreground">{hunk.reason}</p> :
                    <label className="inline-flex items-center gap-2 px-1 text-sm">
                      <input type="checkbox" className="size-4 shrink-0 accent-primary" aria-describedby={`${diffId}-${index}`}
                        checked={selected.includes(index)} disabled={busy}
                        onChange={event => setSelected(event.target.checked
                          ? [...selected, index].sort((a, b) => a - b)
                          : selected.filter(item => item !== index))} />
                      Apply change
                    </label>}
                </div>
              ))}
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {file?.kind === "note" && applicable.length > 0 && (
          <DialogFooter className="sm:justify-between">
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={busy || selected.length === applicable.length}
                onClick={() => setSelected(applicable)}>Apply all</Button>
              <Button size="sm" variant="ghost" disabled={busy || !selected.length}
                onClick={() => setSelected([])}>Skip all</Button>
            </div>
            <Button size="sm" disabled={busy || !selected.length} onClick={() => void apply(file)}>
              {busy ? "Applying…" : "Apply selected changes"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
