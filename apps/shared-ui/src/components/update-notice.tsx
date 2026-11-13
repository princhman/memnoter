import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { Button } from "@/components/ui/button";
import { updateRequiredStore } from "@/lib/update-required";
import { latestRelease } from "@/lib/releases";
import { IS_IOS } from "@/lib/platform";
import { openExternalLink } from "@/lib/backend";

export function UpdateNotice() {
  const required = useSelector(updateRequiredStore, state => state);
  const [available, setAvailable] = useState<string | null>(null);
  useEffect(() => { void latestRelease(import.meta.env.VITE_APP_VERSION).then(tag => {
    try { if (tag !== localStorage.getItem("memnoter-dismissed-release")) setAvailable(tag); } catch { /* Storage unavailable. */ }
  }); }, []);
  if (!required && !available) return null;
  return <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 bg-muted px-3 py-2 text-sm">
    <span className="min-w-0 flex-1">{required ? "Memnoter needs an update to keep syncing" : "Update available"}</span>
    <Button size="sm" variant={required ? "default" : "secondary"} onClick={() => openExternalLink(IS_IOS ? "itms-beta://" : "https://memnoter.com/#download")}>{IS_IOS ? "Open TestFlight" : "Download update"}</Button>
    {!required && <Button size="sm" variant="ghost" onClick={() => {
      try { localStorage.setItem("memnoter-dismissed-release", available!); } catch { /* Still dismiss for this launch. */ }
      setAvailable(null);
    }}>Dismiss</Button>}
  </div>;
}
