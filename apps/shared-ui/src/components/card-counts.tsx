import type { CardCounts as Counts } from "@/lib/card-sync";
import { cn } from "@/lib/utils";

const PARTS = [
  { key: "new", label: "new", className: "text-sky-600 dark:text-sky-400" },
  { key: "learning", label: "learning", className: "text-red-600 dark:text-red-400" },
  { key: "review", label: "to review", className: "text-emerald-600 dark:text-emerald-400" },
] as const;

export type CardCountKind = (typeof PARTS)[number]["key"];

// FSRS states: 0 new, 1 learning, 2 review, 3 relearning.
export function cardCountKind(state: number): CardCountKind {
  return state === 0 ? "new" : state === 2 ? "review" : "learning";
}

// Cards due now as Anki shows them: new, learning and to review, each in its
// own colour, faded when zero. Each count carries a superscript +n, in its
// colour, for its cards due later today.
// `current`, during a review, marks the count the card on screen belongs to.
export function CardCounts({ counts, current, className }: { counts: Counts; current?: CardCountKind | null; className?: string }) {
  const later = (key: CardCountKind) => counts.laterToday?.[key] ?? 0;
  const label = PARTS.map(({ key, label }) =>
    `${counts[key]} ${label}${later(key) > 0 ? ` (+${later(key)} later today)` : ""}`,
  ).join(", ") + (current ? `, reviewing ${PARTS.find(({ key }) => key === current)?.label}` : "");
  return (
    <span className={cn("inline-flex gap-1.5 tabular-nums", className)} aria-label={label} title={label}>
      {PARTS.map(({ key, className }) => (
        <span
          key={key}
          aria-hidden
          className={className}
        >
          <span className={cn(counts[key] === 0 && "opacity-40", key === current && "font-bold underline underline-offset-2")}>{counts[key]}</span>
          {later(key) > 0 && <sup className="ml-px text-[0.65em] opacity-70">+{later(key)}</sup>}
        </span>
      ))}
    </span>
  );
}
