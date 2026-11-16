import type { ComponentProps } from "react";
import { CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";

function Kbd({ className, children, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    >
      {typeof children === "string"
        ? children.split(/(↵|Enter)/).map((part, index) =>
            part === "↵" || part === "Enter"
              ? <CornerDownLeft key={index} role="img" aria-label="Enter" />
              : part,
          )
        : children}
    </kbd>
  );
}

function KbdGroup({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
