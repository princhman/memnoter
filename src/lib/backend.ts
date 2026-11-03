import { invoke, convertFileSrc } from "@tauri-apps/api/core";
export { listen } from "@tauri-apps/api/event";

export const call = <T>(command: string, args?: object): Promise<T> =>
  invoke<T>(command, args as Record<string, unknown> | undefined);

export const fileUrl = (path: string): string => convertFileSrc(path);
