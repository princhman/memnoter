import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// A tooltip naming an icon-only button, with its shortcut if it has one. The
// button still needs its own aria-label.
export function IconTooltip({
  label,
  hint,
  side,
  children,
}: {
  label: string;
  hint?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {hint ? (
          <span className="grid gap-0.5">
            <strong className="font-medium">{label}</strong>
            <span className="text-muted-foreground">{hint}</span>
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  );
}
