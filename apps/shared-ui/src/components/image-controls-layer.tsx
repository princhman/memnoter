import { autoUpdate } from "@floating-ui/dom";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// Keep controls outside both contenteditable and the table's scrolling viewport.
export function ImageControlsLayer({ anchor, children }: {
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const controls = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = anchor.current;
    const popup = controls.current;
    if (!host || !popup) return;
    const scroller = host.closest<HTMLElement>(".app-scroll-container");
    const position = () => {
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 8;
      const top = Math.max(viewport?.offsetTop ?? 0,
        scroller ? scroller.getBoundingClientRect().top + Number(scroller.dataset.topInset ?? 0) : 0) + 8;
      const right = left + (viewport?.width ?? window.innerWidth) - 16;
      const bottom = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
        scroller ? scroller.getBoundingClientRect().bottom - Number(scroller.dataset.bottomInset ?? 0) : window.innerHeight) - 8;
      popup.style.maxWidth = `${Math.max(0, right - left)}px`;
      popup.style.maxHeight = `${Math.max(0, bottom - top)}px`;
      const rect = (host.querySelector("img") ?? host).getBoundingClientRect();
      const size = popup.getBoundingClientRect();
      let clipLeft = left, clipRight = right, clipTop = top, clipBottom = bottom;
      for (let parent = host.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          clipLeft = Math.max(clipLeft, bounds.left);
          clipRight = Math.min(clipRight, bounds.right);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          clipTop = Math.max(clipTop, bounds.top);
          clipBottom = Math.min(clipBottom, bounds.bottom);
        }
      }
      popup.style.visibility = rect.right <= clipLeft || rect.left >= clipRight || rect.bottom <= clipTop || rect.top >= clipBottom ? "hidden" : "visible";
      popup.style.left = `${Math.max(left, Math.min(rect.left, right - size.width))}px`;
      const below = rect.bottom + 8;
      popup.style.top = `${Math.max(top, Math.min(below + size.height <= bottom ? below : rect.top - size.height - 8, bottom - size.height))}px`;
    };
    // The image element can be replaced after downloading or changing source.
    // Observe its stable host and resolve the current image when positioning.
    const cleanup = autoUpdate(host, popup, position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    const observer = new MutationObserver(position);
    if (scroller) observer.observe(scroller, { attributes: true, attributeFilter: ["data-top-inset", "data-bottom-inset"] });
    return () => {
      cleanup();
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [anchor]);

  return createPortal(<div ref={controls} className="note-image-controls" data-floating aria-label="Image controls" contentEditable={false}
    onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => {
      // Toolbar buttons keep the node selected and the native keyboard closed.
      // Description inputs still need ordinary focus and text selection.
      if (!(event.target instanceof Element) || !event.target.closest("input, textarea")) event.preventDefault();
      event.stopPropagation();
    }}>
    {children}
  </div>, document.body);
}
