const listeners = new Set<() => void>();
export function cardsChanged() { listeners.forEach(listener => listener()); }
export function onCardsChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
