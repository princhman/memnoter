import { MentionedIn } from "./mentions";
import { editorHost } from "@/lib/editor-host";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { isCoarsePointer } from "@/lib/platform";
import { ToolButton } from "./ui/tool-button";
import { Maximize2, Minimize2 } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { sectionFocusKey } from "@/lib/section-focus";

const HEADING_ACTION_SIZE = 28;

export const HeadingActionOverlay = ({
  children,
  editor,
  moduleId,
}: {
  children: ReactNode;
  editor: Editor | null;
  moduleId: string;
}) => {
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const shellRef = useRef<HTMLElement>(null);
  const hoveredHeadingRef = useRef<HTMLHeadingElement | null>(null);
  // A mouse or trackpad is over the shell, so hover decides the heading.
  const mouseInsideRef = useRef(false);
  const [headingActionPosition, setHeadingActionPosition] =
    useState<HeadingActionPosition | null>(null);

  // Keep the row available for keyboard navigation while the caret is in a heading.
  useEffect(() => {
    if (!editor) return;
    const follow = () => {
      if (backlinksOpen || shellRef.current?.querySelector("[data-heading-action]:focus-within")) return;
      if (editor.view.hasFocus() || isCoarsePointer()) showCaretHeading();
    };
    follow();
    editor.on("transaction", follow);
    editor.on("focus", follow);
    return () => { editor.off("transaction", follow); editor.off("focus", follow); };
  }, [editor, backlinksOpen]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const reposition = () => {
      const heading = hoveredHeadingRef.current;
      if (heading?.isConnected) positionHeadingAction(heading);
    };
    const observer = new ResizeObserver(reposition);
    observer.observe(shell);
    window.addEventListener("resize", reposition);
    return () => { observer.disconnect(); window.removeEventListener("resize", reposition); };
  }, [editor]);

  function getCaretHeading(): HTMLHeadingElement | null {
    if (!editor || editor.isDestroyed) return null;
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name !== "heading") continue;
      let dom: Node | null = null;
      try {
        dom = editor.view.nodeDOM($from.before(depth));
      } catch (error) {
      console.error("Failed to update heading action selection:", error);
        // The view isn't mounted yet.
      }
      return dom instanceof HTMLElement
        ? dom.closest<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6")
        : null;
    }
    return null;
  }

  function showCaretHeading() {
    const heading = getCaretHeading();
    hoveredHeadingRef.current = heading;
    if (heading) positionHeadingAction(heading);
    else setHeadingActionPosition(null);
  }

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
    } catch (error) {
      console.error("Failed to update heading action selection:", error);
      // The heading can be replaced by an editor transaction between hover and click.
    }
    return null;
  }

  function handlePointerOver(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "touch" || backlinksOpen || shellRef.current?.querySelector("[data-heading-action]:focus-within")) return;
    mouseInsideRef.current = true;
    const target = event.target;

    if (!(target instanceof Element)) return;
    if (target.closest("[data-heading-action], [data-backlink-popover]")) return;

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

  // `refresh` re-renders even when the button stays put, e.g. to swap its icon.
  function positionHeadingAction(heading: HTMLElement, refresh = false) {
    const shell = shellRef.current;
    if (!shell) return;

    const shellRect = shell.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const left = headingRect.right - shellRect.left - HEADING_ACTION_SIZE;
    const top =
      headingRect.top - shellRect.top + (headingRect.height - HEADING_ACTION_SIZE) / 2;
    // Touch screens reposition on every transaction; skip renders that move nothing.
    setHeadingActionPosition((current) =>
      !refresh && current?.left === left && current.top === top
        ? current
        : { left, top },
    );
  }

  function handlePointerLeave(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    mouseInsideRef.current = false;
    if (backlinksOpen || shellRef.current?.querySelector("[data-heading-action]:focus-within")) return;
    if (isCoarsePointer() || editor?.view.hasFocus()) {
      showCaretHeading();
      return;
    }
    hoveredHeadingRef.current = null;
    setHeadingActionPosition(null);
  }

  function onClick() {
    const headingPosition = getHoveredHeadingPosition();
    const heading = hoveredHeadingRef.current;
    if (!editor || headingPosition === null || !heading) return;

    const container = editorHost.scrollContainer(heading);
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
    positionHeadingAction(heading, true);
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
      onFocusCapture={event => {
        if (event.target === editor?.view.dom) showCaretHeading();
      }}
      onBlurCapture={event => {
        if (event.relatedTarget instanceof Node && shellRef.current?.contains(event.relatedTarget)) return;
        requestAnimationFrame(() => {
          const focused = document.activeElement;
          if (backlinksOpen || mouseInsideRef.current || shellRef.current?.contains(focused) || focused?.closest("[data-backlink-popover]")) return;
          hoveredHeadingRef.current = null;
          setHeadingActionPosition(null);
        });
      }}
      onKeyDownCapture={event => {
        if (event.altKey && event.key === "F10" && getCaretHeading()) {
          event.preventDefault();
          showCaretHeading();
          requestAnimationFrame(() => shellRef.current?.querySelector<HTMLButtonElement>("[data-heading-action] button")?.focus());
        } else if (event.key === "Escape" && event.target instanceof Element && event.target.closest("[data-heading-action]") && !backlinksOpen) {
          event.preventDefault();
          editor?.commands.focus();
        }
      }}
    >
      {children}
      {headingActionPosition && (
        <HeadingAction
          backlinks={<MentionedIn onOpenChange={setBacklinksOpen} target={{ kind: "heading", id: moduleId, nodeId: hoveredHeadingRef.current?.getAttribute("data-toc-id") ?? null, locator: null }} />}
          position={headingActionPosition}
          level={hoveredHeadingRef.current?.tagName ?? ""}
          onClick={onClick}
          inFocus={isCurrentlyInFocus}
        />
      )}
    </main>
  );
};

type HeadingActionPosition = {
  left: number;
  top: number;
};

type HeadingActionProps = {
  backlinks: ReactNode;
  position: HeadingActionPosition;
  level: string;
  onClick: () => void;
  inFocus: () => boolean;
};

function HeadingAction({
  backlinks,
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
      className="absolute z-10 flex flex-nowrap items-center gap-2 whitespace-nowrap rounded-md bg-background"
      role="toolbar"
      aria-label="Heading controls"
      aria-keyshortcuts="Alt+F10"
      style={{
        ...position,
        transform: `translateX(calc(${HEADING_ACTION_SIZE}px - 100%))`,
      }}
    >
      {backlinks}
      <span className="shrink-0 text-xs text-muted-foreground">{level}</span>
      <ToolButton label={label}
          data-heading-action=""
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
        >
          {focused ? <Minimize2 /> : <Maximize2 />}
        </ToolButton>
    </div>
  );
}
