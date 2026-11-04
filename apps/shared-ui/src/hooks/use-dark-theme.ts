import { useSyncExternalStore } from "react";

// Follows the `dark` class that main.tsx keeps in sync with the system theme.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const isDark = () => document.documentElement.classList.contains("dark");

export function useDarkTheme() {
  return useSyncExternalStore(subscribe, isDark);
}
