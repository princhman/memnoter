// Share one observer and one mount frame across an editor's formula views.
// Keep rendered views mounted: scrolling back should not repeat their work.
export function createViewportRenderer() {
  const pending = new Map<HTMLElement, () => void>();
  let observer: IntersectionObserver | undefined;
  let frame: number | undefined;

  function cancel(element: HTMLElement) {
    pending.delete(element);
    observer?.unobserve(element);
    if (pending.size === 0) {
      observer?.disconnect();
      observer = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    }
  }

  return function defer(element: HTMLElement, render: () => void) {
    if (typeof IntersectionObserver === "undefined") {
      render();
      return () => {};
    }

    pending.set(element, render);
    if (observer) {
      observer.observe(element);
    } else if (frame === undefined) {
      // Node views are constructed before their DOM is attached. Wait until
      // mount so the observer uses the actual note scroll container as root.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const target = entry.target as HTMLElement;
              const callback = pending.get(target);
              if (!callback) continue;
              cancel(target);
              callback();
            }
          },
          {
            root: pending.keys().next().value?.closest(".app-scroll-container") ?? null,
            rootMargin: "800px 0px",
          },
        );
        for (const target of pending.keys()) observer.observe(target);
      });
    }

    return () => cancel(element);
  };
}
