import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { HeadingAction, type HeadingActionPosition } from "./heading-action";
import type { Editor } from "@tiptap/core";
import { sectionFocusKey } from "@/lib/section-focus";

const HEADING_ACTION_SIZE = 28;

export const HeadingActionOverlay = ({
  children,
  editor,
}: {
  children: ReactNode;
  editor: Editor | null;
}) => {
  const shellRef = useRef<HTMLElement>(null);
  const hoveredHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [headingActionPosition, setHeadingActionPosition] =
    useState<HeadingActionPosition | null>(null);

  function getHoveredHeadingPosition(): number | null {
    const heading = hoveredHeadingRef.current;
    if (
      !editor ||
      !heading?.isConnected ||
      !editor.view.dom.contains(heading)
    ) {
      return null;
    }

    const contentPosition = editor.view.posAtDOM(heading, 0);
    if (
      contentPosition < 0 ||
      contentPosition > editor.state.doc.content.size
    ) {
      return null;
    }

    try {
      const resolved = editor.state.doc.resolve(contentPosition);
      for (let depth = resolved.depth; depth > 0; depth -= 1) {
        if (resolved.node(depth).type.name === "heading") {
          return resolved.before(depth);
        }
      }
    } catch {
      // The heading can be replaced by an editor transaction between hover and click.
    }
    return null;
  }

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

    positionHeadingAction(heading);
  }

  function positionHeadingAction(heading: HTMLElement) {
    const shell = shellRef.current;
    if (!shell) return;

    const shellRect = shell.getBoundingClientRect();
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

  function onClick() {
    const headingPosition = getHoveredHeadingPosition();
    const heading = hoveredHeadingRef.current;
    if (!editor || headingPosition === null || !heading) return;

    const container = heading.closest<HTMLElement>(".app-scroll-container");
    if (isCurrentlyInFocus()) {
      // Revealing the rest of the note pushes the heading down; scroll by the
      // same amount so it stays where it was on screen.
      const before = heading.getBoundingClientRect().top;
      editor.commands.showDocument();
      if (container) {
        container.scrollTop += heading.getBoundingClientRect().top - before;
      }
    } else {
      editor.commands.showSection(headingPosition);
      heading.scrollIntoView({ block: "start" });
    }
    // The heading moved inside the shell, so move the button with it.
    positionHeadingAction(heading);
  }

  function isCurrentlyInFocus(): boolean {
    const headingPosition = getHoveredHeadingPosition();
    if (!editor || headingPosition === null) return false;

    const focusedPos = sectionFocusKey.getState(editor.state);
    if (
      focusedPos == null ||
      focusedPos < 0 ||
      focusedPos >= editor.state.doc.content.size
    )
      return false;
    const focusedNode = editor.state.doc.nodeAt(focusedPos);
    if (focusedNode?.type.name !== "heading" || focusedPos !== headingPosition)
      return false;
    return true;
  }

  return (
    <main
      ref={shellRef}
      className="tiptap-shell"
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
    >
      {children}
      {headingActionPosition && (
        <HeadingAction
          position={headingActionPosition}
          level={hoveredHeadingRef.current?.tagName ?? ""}
          onClick={onClick}
          inFocus={isCurrentlyInFocus}
        />
      )}
    </main>
  );
};
