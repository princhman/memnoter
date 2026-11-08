import { IS_APPLE } from "./platform.ts";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Compatibility for callers that only display the modifier.
export const MOD_KEY = IS_APPLE ? "⌘" : "Ctrl+";
