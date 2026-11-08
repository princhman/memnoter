import { FILE_SCHEME, type NativeEvent, type NativeEvents } from "../editor-host/protocol.ts";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

type NativeMessage = { kind: "call"; id: string; command: string; args: object } |
  NativeEvent;
type Handler = (event: { event: string; id: number; payload: unknown }) => void;

declare global {
  interface Window {
    webkit?: { messageHandlers?: { memnoter?: { postMessage(message: NativeMessage): void } } };
    __memnoterBridge: {
      resolve(id: string, resultJson: unknown): void;
      reject(id: string, message: string): void;
      emit(event: string, payloadJson: unknown): void;
    };
  }
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isNativeHost = () => !isTauri() && !!window.webkit?.messageHandlers?.memnoter;
let sequence = 0;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const listeners = new Map<string, Set<Handler>>();

// Values are decoded JSON values, never JSON text. Install before the first call.
function installBridge() {
  window.__memnoterBridge = {
    resolve(id, value) {
      const request = pending.get(id);
      pending.delete(id);
      request?.resolve(value);
    },
    reject(id, message) {
      const request = pending.get(id);
      pending.delete(id);
      request?.reject(new Error(message));
    },
    emit(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) {
        try { handler({ event, payload, id: 0 }); }
        catch (error) { console.error("Native event handler failed", error); }
      }
    },
  };
}
if (typeof window !== "undefined") installBridge();

export function call<T>(command: string, args?: object): Promise<T> {
  if (!isNativeHost()) {
    const shell = command.startsWith("plugin:") || ["confirm_exit", "confirm_restart", "set_editor_history", "pick_import_folder", "read_import_images"].includes(command);
    return (shell ? invoke<T>(command, args as Record<string, unknown> | undefined)
      : invoke<T>("core", { command, args: args ?? {} })).catch(error => {
        throw new Error(typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));
      });
  }
  return new Promise<T>((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve: value => resolve(value as T), reject });
    try {
      window.webkit!.messageHandlers!.memnoter!.postMessage({ kind: "call", id, command, args: args ?? {} });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

export async function listen<T>(event: string, handler: (event: { event: string; id: number; payload: T }) => void): Promise<() => void> {
  if (!isNativeHost()) return tauriListen<T>(event, handler);
  const handlers = listeners.get(event) ?? new Set<Handler>();
  listeners.set(event, handlers);
  const wrapped: Handler = value => handler({ ...value, payload: value.payload as T });
  handlers.add(wrapped);
  return () => {
    handlers.delete(wrapped);
    if (!handlers.size) listeners.delete(event);
  };
}

export function postNativeEvent<K extends keyof NativeEvents>(event: K, ...args: null extends NativeEvents[K] ? [payload?: NativeEvents[K]] : [payload: NativeEvents[K]]) {
  if (isNativeHost()) window.webkit!.messageHandlers!.memnoter!.postMessage({ kind: "event", event, payload: args[0] ?? null } as NativeEvent);
}

export function fileUrl(path: string): string {
  if (!isNativeHost()) return convertFileSrc(path);
  // All current consumers use FileType.path: <app data>/files/<file id>.
  // Relative files/<id> receipts are accepted too; arbitrary paths are rejected.
  const normalized = path.replace(/\\/g, "/");
  const relative = normalized.startsWith("files/") ? normalized : normalized.slice(normalized.lastIndexOf("/files/") + 1);
  const parts = relative.split("/");
  if (parts.length !== 2 || parts[0] !== "files" || !parts[1] || parts.some(part => part === "." || part === "..")) {
    throw new Error("Expected an app data files/<id> path");
  }
  return `${FILE_SCHEME}://localhost/${parts.map(encodeURIComponent).join("/")}`;
}
