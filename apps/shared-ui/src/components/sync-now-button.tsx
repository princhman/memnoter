import { useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { Loader2, RefreshCw } from "lucide-react";
import { IconTooltip } from "@/components/icon-tooltip";
import { Button } from "@/components/ui/button";
import { syncNow, syncStatusStore } from "@/lib/sync/manager";

const lastSyncedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function SyncNowButton() {
  const { account, state, error, lastSyncedAt } = useSelector(syncStatusStore, (status) => status);
  const [starting, setStarting] = useState(false);
  if (!account) return null;

  const busy = starting || state === "connecting" || state === "syncing";
  let label = "Sync now";
  if (busy) label = "Syncing…";
  else if (error) label = error;
  else if (lastSyncedAt !== null) label = `Last synced ${lastSyncedFormat.format(lastSyncedAt)}`;

  async function start() {
    if (busy) return;
    setStarting(true);
    try {
      await syncNow();
    } finally {
      setStarting(false);
    }
  }

  return (
    <IconTooltip label={label} side="top">
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label="Sync now"
        aria-busy={busy}
        aria-disabled={busy}
        onClick={start}
      >
        {busy ? <Loader2 className="motion-safe:animate-spin" /> : <RefreshCw />}
      </Button>
    </IconTooltip>
  );
}
