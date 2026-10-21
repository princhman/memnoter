import { Button } from "./ui/button";
import { Maximize2, Minimize2 } from "lucide-react";

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
      <Button
        data-heading-action=""
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        size="icon-sm"
        variant="ghost"
        style={position}
      >
        {inFocus() ? <Minimize2 /> : <Maximize2 />}
      </Button>
    </div>
  );
}
