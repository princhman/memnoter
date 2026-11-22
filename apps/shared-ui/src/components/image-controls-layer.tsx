import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// Use the resize wrapper so the controls share the image's size and scrolling.
export function ImageControlsLayer({ anchor, children }: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const controls = <span className="note-image-controls" aria-label="Image controls" contentEditable={false}
    onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => {
      // Toolbar buttons keep the node selected and the native keyboard closed.
      // Description inputs still need ordinary focus and text selection.
      if (!(event.target instanceof Element) || !event.target.closest("input, textarea")) event.preventDefault();
      event.stopPropagation();
    }}>
    {children}
  </span>;
  return anchor ? createPortal(controls, anchor) : controls;
}
