import { cn } from "@/lib/utils";

// Shared reading geometry only; worksheet revisions never inherit bank actions.
export const questionReadingWidth = "mx-auto w-full max-w-3xl";
export const questionCropClass = "block max-w-full rounded-sm bg-white";
export const questionHeadingClass = "relative flex min-h-7 min-w-0 items-start gap-1 rounded-sm";
export const ownPartLabel = (label: string) => `(${label.replace(/^\((.*)\)$/, "$1")})`;

export function questionReadingLayout(depth: number, folded: boolean, hasCrops: boolean, reordering = false) {
  const root = depth === 0;
  const inline = !reordering && !folded && hasCrops;
  return {
    // Parts sit visibly inside their question: one step per level, from (a) on.
    marginLeft: depth * 28,
    partClass: cn("group/part", !root && "mt-1", !reordering && !folded && hasCrops && "pb-2", inline && "grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-2"),
    labelClass: cn("min-w-0 text-left font-semibold tabular-nums [overflow-wrap:anywhere]", root ? "text-xl leading-7" : "text-base leading-7 text-muted-foreground"),
    contentClass: cn("min-w-0 space-y-3 empty:hidden", reordering ? "hidden" : !inline && (root ? "mt-2 pl-14" : "mt-2 pl-5")),
  };
}
