import { useQuery } from "@tanstack/react-query";
import { call } from "./backend";
import { queryClient } from "./query-client";
import type { Module } from "./types";

export const modulesKey = ["modules"] as const;
export function useModules(options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: modulesKey, queryFn: () => call<Module[]>("modules"), ...options });
}
export const modulesCache = {
  patch(patch: (modules: Module[]) => Module[]) {
    queryClient.setQueryData<Module[]>(modulesKey, modules => modules && patch(modules));
  },
  rename(id: string, name: string) {
    modulesCache.patch(modules => modules.map(module => module.id === id ? { ...module, name } : module));
  },
  remove(id: string) {
    modulesCache.patch(modules => modules.filter(module => module.id !== id));
  },
  invalidate() { return queryClient.invalidateQueries({ queryKey: modulesKey }); },
};
