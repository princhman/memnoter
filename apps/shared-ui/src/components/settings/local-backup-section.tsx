import { useMutation, useQuery } from "@tanstack/react-query";
import { backupReview } from "./backup-edits-dialog";
import { readBackupReview } from "@/lib/backup-edit-review";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { call } from "@/lib/backend";
import { localBackupError, localBackupSettings, type LocalBackupSettings } from "@/lib/local-backup";
import { queryClient } from "@/lib/query-client";

export default function LocalBackupSection() {
  const { data, error: loadError, isPending } = useQuery(localBackupSettings);
  const { data: backupError } = useQuery(localBackupError);
  const save = useMutation({
    mutationFn: (action: { kind: "pick" } | { kind: "toggle"; enabled: boolean }) =>
      action.kind === "pick"
        ? call<LocalBackupSettings>("pick_local_backup_folder")
        : call<LocalBackupSettings>("set_local_backup_enabled", { enabled: action.enabled }),
    onSuccess: settings => queryClient.setQueryData(localBackupSettings.queryKey, settings),
  });
  const check = useMutation({
    mutationFn: async (folder: string) => ({ folder, files: await readBackupReview(folder) }),
    onSuccess: review => backupReview.setState(() => review),
  });
  const error = loadError?.message ?? save.error?.message ?? check.error?.message ?? backupError;

  return (
    <section aria-labelledby="local-backup-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="local-backup-heading" className="font-medium">Local backup</h2>
        <p className="text-sm text-muted-foreground">
          Export Markdown, images and PDFs to a Memnoter Backup folder every 10 minutes while the app is open.
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="min-w-0 break-all">{data?.folder ?? "Backup folder"}</span>
        <Button variant="outline" size="sm" className="shrink-0" disabled={isPending || save.isPending || check.isPending}
          onClick={() => save.mutate({ kind: "pick" })}>
          {data?.folder ? "Change folder" : "Choose folder"}
        </Button>
      </div>
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>Automatic backup</span>
        <Switch checked={data?.enabled ?? false} disabled={!data?.folder || save.isPending || check.isPending}
          onCheckedChange={enabled => save.mutate({ kind: "toggle", enabled })} />
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div>
        <Button variant="outline" size="sm" disabled={!data?.folder || check.isPending || save.isPending}
          onClick={() => { if (data?.folder) check.mutate(data.folder); }}>
          {check.isPending ? "Checking backup…" : "Check backup for edits"}
        </Button>
      </div>
    </section>
  );
}
