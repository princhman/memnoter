import { isNativeHost } from "./backend";

export const editorHost = {
  get isNative() { return isNativeHost(); },
  get restoreFocus() { return !this.isNative; },
  scrollContainer(element: Element) {
    return element.closest<HTMLElement>(".app-scroll-container");
  },
};

const navigationListeners = new WeakMap<HTMLElement, Set<() => void>>();
export function onHostNavigation(container: HTMLElement, listener: () => void) {
  let listeners = navigationListeners.get(container);
  if (!listeners) navigationListeners.set(container, listeners = new Set());
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function beginHostNavigation(container: HTMLElement) {
  navigationListeners.get(container)?.forEach(listener => listener());
}
