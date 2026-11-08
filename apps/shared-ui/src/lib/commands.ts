import { SHORTCUTS, formatKeys } from "./shortcuts.ts";
import { useEffect, useSyncExternalStore } from "react";

// Runtime availability and handlers for palette actions. Known shortcut metadata
// comes from the shared action table; context-specific commands can add their own.
export type Command = {
  id: string;
  title: string;
  shortcut?: string;
  keywords?: string[];
  run: () => void | Promise<void>;
};

let commands: Command[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function registerCommand(command: Command) {
  const entry = SHORTCUTS.find((entry) => entry.id === command.id);
  if (entry) command = { ...command, title: entry.title, shortcut: entry.keys ? formatKeys(entry.keys) : undefined };
  commands = [...commands.filter((other) => other.id !== command.id), command];
  emit();
  return () => {
    if (!commands.includes(command)) return;
    commands = commands.filter((other) => other !== command);
    emit();
  };
}

export function getCommands() {
  return commands;
}

export function useCommands() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getCommands);
}

export function useCommand(command: Command) {
  const { id, title, shortcut, keywords, run } = command;
  const keywordKey = keywords?.join(" ");
  useEffect(
    () => registerCommand({ id, title, shortcut, keywords, run }),
    // keywords is compared by content so inline arrays do not re-register.
    [id, title, shortcut, keywordKey, run],
  );
}

// Every word of the query must start a word of the title or keywords.
export function matchesCommand(command: Command, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [command.title, ...(command.keywords ?? [])]
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  return words.every((word) =>
    haystack.some((candidate) => candidate.startsWith(word)),
  );
}
