import { useEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

let region: HTMLDivElement | undefined;
let users = 0;

// All toast producers share layout, including when they mount independently.
export function Toast({ className, ...props }: ComponentProps<"div">) {
  const [target, setTarget] = useState<HTMLDivElement>();
  useEffect(() => {
    if (!region) {
      region = document.createElement("div");
      region.className = "toast-region";
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", "Notifications");
      document.body.append(region);
    }
    users++;
    setTarget(region);
    return () => {
      if (--users === 0) { region?.remove(); region = undefined; }
    };
  }, []);
  return target ? createPortal(
    <div className={cn("floating-surface pointer-events-auto max-w-full", className)} {...props} />,
    target,
  ) : null;
}
