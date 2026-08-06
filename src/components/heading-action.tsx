import { Button } from "./ui/button";
import { Maximize2 } from "lucide-react";

export type HeadingActionPosition = {
  left: number;
  top: number;
};

type HeadingActionProps = {
  position: HeadingActionPosition;
};

export function HeadingAction({ position }: HeadingActionProps) {
  function handleClick() {
    console.log("clicked");
  }

  return (
    <Button
      data-heading-action=""
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
      size="icon-sm"
      variant="ghost"
      className="absolute z-10"
      style={position}
    >
      <Maximize2 />
    </Button>
  );
}
