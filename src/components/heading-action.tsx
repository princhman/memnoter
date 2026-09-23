import { Button } from "./ui/button";
import { Maximize2, Minimize2 } from "lucide-react";

export type HeadingActionPosition = {
  left: number;
  top: number;
};

type HeadingActionProps = {
  position: HeadingActionPosition;
  onClick: () => void;
  inFocus: () => boolean;
};

export function HeadingAction({
  position,
  onClick,
  inFocus,
}: HeadingActionProps) {
  return (
    <Button
      data-heading-action=""
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      size="icon-sm"
      variant="ghost"
      className="absolute z-10"
      style={position}
    >
      {inFocus() ? <Minimize2 /> : <Maximize2 />}
    </Button>
  );
}
