import { useRouterState } from "@tanstack/react-router";

type Match = { params: object };
export function openModuleId(matches: readonly Match[]): string | undefined {
  for (const match of matches) {
    if ("moduleId" in match.params && typeof match.params.moduleId === "string") return match.params.moduleId;
  }
}
export function isShowingModule(matches: readonly Match[], moduleId: string) {
  return openModuleId(matches) === moduleId;
}
export function useOpenModuleId() {
  return useRouterState({ select: state => openModuleId(state.matches) });
}
