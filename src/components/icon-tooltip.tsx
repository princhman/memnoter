import { useRef, type ReactElement, type RefObject } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// A tooltip naming an icon-only button, with its shortcut if it has one. The
// button still needs its own aria-label.
export function IconTooltip({
  label,
  hint,
  side,
  children,
  container,
}: {
  label: string;
  hint?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
  container?: HTMLElement | RefObject<HTMLElement | null> | null;
}) {
  const actions = useRef<{ close: () => void; unmount: () => void } | null>(null);
  return (
    <Tooltip actionsRef={actions} onOpenChange={(_open, details) => {
      if (details.reason === "escape-key") {
        // Let Escape also close the containing menu or native dialog.
        details.cancel();
        details.allowPropagation();
        actions.current?.close();
      }
    }}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} container={container}>
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
