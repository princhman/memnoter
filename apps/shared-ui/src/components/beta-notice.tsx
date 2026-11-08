import { useState } from "react";
import { openLink } from "@/lib/link-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function BetaNotice() {
  return (
    <>
      Memnoter is in beta, so bugs are expected. Please send a report or message to{" "}
      <a
        href="mailto:hello@memnoter.com"
        className="underline underline-offset-3 hover:text-foreground"
        onClick={(event) => {
          event.preventDefault();
          openLink(event.currentTarget.href);
        }}
      >
        hello@memnoter.com
      </a>{" "}
      or{" "}
      <a
        href="https://github.com/princhman/memnoter/issues"
        className="underline underline-offset-3 hover:text-foreground"
        onClick={(event) => {
          event.preventDefault();
          openLink(event.currentTarget.href);
        }}
      >
        Open GitHub issue
      </a>.
    </>
  );
}

export function BetaBadge() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 rounded-full bg-muted px-2 text-xs font-normal text-muted-foreground"
        aria-label="About the Memnoter beta"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Beta
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Memnoter Beta</DialogTitle>
            <DialogDescription><BetaNotice /></DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
