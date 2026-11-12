import type { CardCountKind } from "@/lib/card-count-kind";
import type { CardCounts as Counts } from "@/lib/card-sync";
import { cn } from "@/lib/utils";

import { COUNT_PARTS as PARTS, reviewCountsLabel } from "@/lib/review-palette";

export { cardCountKind, type CardCountKind } from "@/lib/card-count-kind";

// Counts are learn / due / new. Learn and due carry a superscript +n
// for cards due later today.
// `current`, during a review, marks the count the card on screen belongs to.
export function CardCounts({ counts, current, className }: { counts: Counts; current?: CardCountKind | null; className?: string }) {
  const later = (key: CardCountKind) => counts.laterToday?.[key] ?? 0;
  const label = reviewCountsLabel(counts, current);
  return (
    <span className={cn("inline-flex gap-1.5 tabular-nums", className)} aria-label={label} title={label}>
      {PARTS.map(({ key, className }) => (
        <span
          key={key}
          aria-hidden
          className={className}
        >
          <span className={cn(key === current && "font-bold underline underline-offset-2")}>{counts[key]}</span>
          {key !== "new" && later(key) > 0 && <sup className="ml-px text-[0.65em]">+{later(key)}</sup>}
        </span>
      ))}
    </span>
  );
}
