import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import {
  HeadingAction,
  type HeadingActionPosition,
} from "./heading-action";

const HEADING_ACTION_SIZE = 28;

export const HeadingActionOverlay = ({
  children,
}: {
  children: ReactNode;
}) => {
  const hoveredHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [headingActionPosition, setHeadingActionPosition] =
    useState<HeadingActionPosition | null>(null);

  function handlePointerOver(event: ReactPointerEvent<HTMLElement>) {
    const target = event.target;

    if (!(target instanceof Element)) return;
    if (target.closest("[data-heading-action]")) return;

    const heading = target.closest<HTMLHeadingElement>(
      "h1, h2, h3, h4, h5, h6",
    );

    if (heading === hoveredHeadingRef.current) return;
    hoveredHeadingRef.current = heading;

    if (!heading || !event.currentTarget.contains(heading)) {
      setHeadingActionPosition(null);
      return;
    }

    const shellRect = event.currentTarget.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    setHeadingActionPosition({
      left: headingRect.right - shellRect.left - HEADING_ACTION_SIZE,
      top:
        headingRect.top -
        shellRect.top +
        (headingRect.height - HEADING_ACTION_SIZE) / 2,
    });
  }

  function handlePointerLeave() {
    hoveredHeadingRef.current = null;
    setHeadingActionPosition(null);
  }

  return (
    <main
      className="tiptap-shell"
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
    >
      {children}
      {headingActionPosition && (
        <HeadingAction position={headingActionPosition} />
      )}
    </main>
  );
};
