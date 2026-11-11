import { capabilities } from "@/lib/backend";
import { useSelector } from "@tanstack/react-store";
import { AlertCircle, Check, Download, Loader2, CircleArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import { checkForUpdates, restartToUpdate, updateStore } from "@/lib/updater";
import type { ReactNode } from "react";

// `children` sit beside the update button, e.g. the Settings button.
const UpdateStatus = ({ children }: { children?: ReactNode }) => {
  const status = useSelector(updateStore, (state) => state);
  const check = () => void checkForUpdates({ manual: true });

  let icon;
  let label: string;
  let onClick: (() => void) | undefined = check;
  switch (status.state) {
    case "checking":
      icon = <Loader2 className="animate-spin" />;
      label = "Checking for updates…";
      onClick = undefined;
      break;
    case "downloading":
      icon = <Download className="animate-pulse" />;
      label = `Downloading v${status.version}${
        status.progress !== null ? ` (${Math.round(status.progress * 100)}%)` : "…"
      }`;
      onClick = undefined;
      break;
    case "ready":
      icon = <CircleArrowUp className="text-sidebar-primary" />;
      label = `Restart to update to v${status.version}`;
      onClick = () => void restartToUpdate();
      break;
    case "up-to-date":
      icon = <Check />;
      label = "Up to date. Check again";
      break;
    case "error":
      icon = <AlertCircle className="text-destructive" />;
      label = `Update failed. Try again (${status.message})`;
      break;
    default:
      icon = <CircleArrowUp />;
      label = "Check for updates";
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <div className="flex items-center">
        {children}
        {/* The App Store updates iOS apps. */}
        {capabilities.updates && <IconTooltip label={label} side="top"><Button
                variant="ghost"
                size="icon-sm"
                className="relative text-muted-foreground"
                aria-label={label}
                aria-disabled={!onClick}
                onClick={onClick}
              >
            {icon}
            {status.state === "ready" && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-sidebar-primary" />
            )}
          </Button></IconTooltip>}
      </div>
    </div>
  );
};

export default UpdateStatus;
