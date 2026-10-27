import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { getVersion } from "@tauri-apps/api/app";
import { AlertCircle, Check, Download, Loader2, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { checkForUpdates, restartToUpdate, updateStore } from "@/lib/updater";

const UpdateStatus = () => {
  const status = useSelector(updateStore, (state) => state);
  const { data: currentVersion } = useQuery({
    queryKey: ["app-version"],
    queryFn: getVersion,
    staleTime: Infinity,
  });
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
        status.progress !== null ? ` · ${Math.round(status.progress * 100)}%` : "…"
      }`;
      onClick = undefined;
      break;
    case "ready":
      icon = <RotateCw className="text-sidebar-primary" />;
      label = `Restart to update to v${status.version}`;
      onClick = () => void restartToUpdate();
      break;
    case "up-to-date":
      icon = <Check />;
      label = "Up to date · Check again";
      break;
    case "error":
      icon = <AlertCircle className="text-destructive" />;
      label = `Update failed · Try again (${status.message})`;
      break;
    default:
      icon = <RefreshCw />;
      label = "Check for updates";
  }

  return (
    <div className="flex items-center justify-between gap-2 pl-2">
      <span className="text-xs text-muted-foreground">
        {currentVersion && `Memnoter v${currentVersion}`}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative text-muted-foreground"
              aria-label={label}
              aria-disabled={!onClick}
              onClick={onClick}
            />
          }
        >
          {icon}
          {status.state === "ready" && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-sidebar-primary" />
          )}
        </TooltipTrigger>
        <TooltipContent side="top" align="end">
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export default UpdateStatus;
