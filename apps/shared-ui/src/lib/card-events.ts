const listeners = new Set<(command?: string) => void>();
export function cardsChanged(command?: string) { listeners.forEach(listener => listener(command)); }
export function onCardsChanged(listener: (command?: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
