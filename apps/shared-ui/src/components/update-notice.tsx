import { useEffect, useRef, useState } from "react";
import { useSelector } from "@tanstack/react-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { updateRequiredStore } from "@/lib/update-required";
import { latestRelease } from "@/lib/releases";
import { IS_IOS } from "@/lib/platform";
import { openExternalLink } from "@/lib/backend";

export function UpdateNotice() {
  const required = useSelector(updateRequiredStore, state => state);
  const [available, setAvailable] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const requiredShown = useRef(false);
  const optionalShown = useRef(false);
  useEffect(() => { void latestRelease(import.meta.env.VITE_APP_VERSION).then(tag => {
    try { if (tag !== localStorage.getItem("memnoter-dismissed-release")) setAvailable(tag); } catch { /* Storage unavailable. */ }
  }); }, []);
  useEffect(() => {
    if (required) {
      if (requiredShown.current) return;
      requiredShown.current = true;
      setOpen(true);
    } else if (available && !requiredShown.current && !optionalShown.current) {
      try {
        // Cache freshness limits network calls; presentation needs its own clock.
        const now = Date.now();
        const lastShown = Number(localStorage.getItem("memnoter-release-popup-shown") ?? 0);
        if (now - lastShown < 86_400_000) return;
        localStorage.setItem("memnoter-release-popup-shown", String(now));
        optionalShown.current = true;
        setOpen(true);
      } catch { /* Without durable throttling, keep optional notices quiet. */ }
    }
  }, [required, available]);
  const dismiss = () => {
    if (!required && available) {
      try { localStorage.setItem("memnoter-dismissed-release", available); } catch { /* Dismiss for this launch. */ }
    }
    setOpen(false);
  };
  return <Dialog open={open} onOpenChange={next => { if (!next) dismiss(); }}>
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{required ? "Memnoter needs an update to keep syncing" : "Update available"}</DialogTitle>
        <DialogDescription>{required
          ? "Your notes are still available on this device. Update Memnoter to resume syncing."
          : "A newer version of Memnoter is available."}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={dismiss}>Later</Button>
        <Button onClick={() => {
          dismiss();
          openExternalLink(IS_IOS ? "itms-beta://" : "https://memnoter.com/#download");
        }}>{IS_IOS ? "Open TestFlight" : "Download update"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
