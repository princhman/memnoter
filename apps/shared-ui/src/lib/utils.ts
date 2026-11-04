import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Shortcut prefix as shown in tooltips.
export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
