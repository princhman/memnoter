import { useEffect, useSyncExternalStore } from "react";

/**
 * Commands listed in the ⌘K palette.
 *
 *   registerCommand({ id: "settings.open", title: "Settings", shortcut: "⌘,", run })
 *
 * Returns a function that removes the command. Registering an id again
 * replaces the earlier command. `shortcut` is only shown, not bound; bind the
 * key where the action lives. `keywords` are extra words the palette matches.
 * From a component, use `useCommand`, which re-registers when `run` changes.
 */
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
