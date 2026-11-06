// Native card menus must never borrow focus from the text responder. Keep this
// policy in editor.html; desktop retains the shared hover/focus interaction.
export function observeCardInfo(container: HTMLElement) {
  const listeners = new AbortController();
  const options = { capture: true, passive: false, signal: listeners.signal };
  let dot: HTMLElement | null = null;
  let popup: HTMLElement | null = null;
  let outside = false;
  let touch: { target: Element; x: number; y: number } | null = null;
  const close = () => {
    if (popup?.isConnected && popup.matches(':popover-open')) popup.hidePopover();
    dot?.removeAttribute('data-info-open');
    dot?.setAttribute('aria-expanded', 'false');
    dot = popup = null;
  };
  const position = () => {
    if (!dot || !popup) return;
    if (!dot.isConnected) { close(); return; }
    const bounds = container.getBoundingClientRect();
    const top = Math.max(0, bounds.top + Number(container.dataset.topInset ?? 0)) + 8;
    const bottom = Math.min(window.innerHeight, bounds.bottom - Number(container.dataset.bottomInset ?? 0)) - 8;
    const left = Math.max(8, bounds.left + 8);
    const right = Math.min(window.innerWidth - 8, bounds.right - 8);
    popup.style.maxWidth = `${Math.max(0, right - left)}px`;
    popup.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const anchor = dot.getBoundingClientRect();
    const size = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(left, Math.min(anchor.left, right - size.width))}px`;
    const below = anchor.bottom + 4;
    popup.style.top = `${Math.max(top, Math.min(below + size.height <= bottom ? below : anchor.top - size.height - 4, bottom - size.height))}px`;
  };
  const cardDot = (target: Element) => target.closest<HTMLElement>('.card-info');
  const handled = (target: Element) => !!dot || !!(container.contains(target) && cardDot(target));
  const cancel = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const activate = (target: Element, event: Event) => {
    if (outside) { cancel(event); outside = false; close(); return; }
    if (popup?.contains(target)) return; // The shared button owns its action.
    const next = cardDot(target);
    if (!next || !container.contains(next)) return;
    cancel(event);
    if (next === dot) { close(); return; }
    close();
    dot = next;
    popup = dot.querySelector<HTMLElement>('.card-info-popup');
    if (!popup) { close(); return; }
    dot.dataset.infoOpen = '';
    dot.setAttribute('aria-expanded', 'true');
    popup.setAttribute('popover', 'manual');
    popup.showPopover(); // Top layer escapes editor overflow without moving DOM/selection.
    position();
  };
  document.addEventListener('pointerdown', event => {
    const target = event.target;
    if (!(target instanceof Element) || !handled(target)) return;
    outside = !!dot && !dot.contains(target);
    // stopEvent on a PM widget does not cancel WebKit's focus default.
    event.preventDefault();
    if (outside) event.stopImmediatePropagation();
  }, options);
  document.addEventListener('mousedown', event => {
    if (event.target instanceof Element && handled(event.target)) {
      event.preventDefault();
      if (outside) event.stopImmediatePropagation();
    }
  }, options);
  document.addEventListener('touchstart', event => {
    const target = event.target;
    if (!(target instanceof Element) || !handled(target)) return;
    outside = !!dot && !dot.contains(target);
    const point = event.touches[0];
    touch = { target, x: point.clientX, y: point.clientY };
    // Leave the popup body scrollable, but cancel focus on its controls and dot.
    if (!popup?.contains(target) || target.closest('button')) event.preventDefault();
    if (outside) event.stopImmediatePropagation();
  }, options);
  document.addEventListener('touchend', event => {
    if (!touch) return;
    const start = touch;
    touch = null;
    const point = event.changedTouches[0];
    cancel(event); // No compatibility click may refocus the editor after dismissal.
    if (Math.hypot(point.clientX - start.x, point.clientY - start.y) > 10) { outside = false; return; }
    if (popup?.contains(start.target)) start.target.closest<HTMLButtonElement>('button')?.click();
    else activate(start.target, event);
  }, options);
  document.addEventListener('touchcancel', () => { touch = null; outside = false; }, options);
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !handled(event.target)) return;
    event.preventDefault();
    activate(event.target, event);
  }, options);
  document.addEventListener('keydown', event => {
    if (dot && event.key === 'Escape') { cancel(event); close(); }
    else if (event.target instanceof Element && cardDot(event.target) && ['Enter', ' '].includes(event.key) && !event.target.closest('button')) {
      activate(event.target, event);
    }
  }, options);
  container.addEventListener('scroll', position, { signal: listeners.signal });
  window.addEventListener('resize', position, { signal: listeners.signal });
  const changes = new MutationObserver(position);
  changes.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-top-inset', 'data-bottom-inset'] });
  return () => { close(); changes.disconnect(); listeners.abort(); };
}
