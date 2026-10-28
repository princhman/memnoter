import { Button } from "./ui/button";
import { Maximize2, Minimize2 } from "lucide-react";
import { IconTooltip } from "./icon-tooltip";

export type HeadingActionPosition = {
  left: number;
  top: number;
};

type HeadingActionProps = {
  position: HeadingActionPosition;
  level: string;
  onClick: () => void;
  inFocus: () => boolean;
};

export function HeadingAction({
  position,
  level,
  onClick,
  inFocus,
}: HeadingActionProps) {
  const focused = inFocus();
  const label = focused ? "Show the whole note" : "Focus on this section";
  return (
    <div
      data-heading-action=""
      className="absolute z-10 flex items-center gap-2"
      style={{
        ...position,
        transform: "translateX(calc(28px - 100%))",
      }}
    >
      <span className="text-xs text-muted-foreground">{level}</span>
      <IconTooltip label={label}>
        <Button
          data-heading-action=""
          type="button"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
          style={position}
        >
          {focused ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </IconTooltip>
    </div>
  );
}
