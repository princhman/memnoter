import type { ComponentProps } from "react";
import { Button } from "./button";
import { IconTooltip } from "./icon-tooltip";

export function ToolButton({
  label, hint, side, container, pressed, ...props
}: Omit<ComponentProps<typeof Button>, "aria-label"> & {
  label: string;
  hint?: string;
  side?: "top" | "bottom" | "left" | "right";
  container?: ComponentProps<typeof IconTooltip>["container"];
  pressed?: boolean;
}) {
  return (
    <IconTooltip label={label} hint={hint} side={side} container={container}>
      <Button size="icon-sm" variant={pressed ? "pressed" : "ghost"}
        aria-label={label} aria-pressed={pressed} {...props} />
    </IconTooltip>
  );
}
