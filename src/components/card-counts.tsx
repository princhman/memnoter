import type { CardCounts as Counts } from "@/lib/card-sync";
import { cn } from "@/lib/utils";

const PARTS = [
  { key: "new", label: "new", className: "text-sky-600 dark:text-sky-400" },
  { key: "learning", label: "learning", className: "text-red-600 dark:text-red-400" },
  { key: "review", label: "to review", className: "text-emerald-600 dark:text-emerald-400" },
] as const;

// Cards due now as Anki shows them: new, learning and to review, each in its
// own colour, with zeros faded. Each count carries a faded superscript +n for
// its cards due later today.
export function CardCounts({ counts, className }: { counts: Counts; className?: string }) {
  const later = (key: (typeof PARTS)[number]["key"]) => counts.laterToday?.[key] ?? 0;
  const label = PARTS.map(({ key, label }) =>
    `${counts[key]} ${label}${later(key) > 0 ? ` (+${later(key)} later today)` : ""}`,
  ).join(", ");
  return (
    <span className={cn("inline-flex gap-1.5 tabular-nums", className)} aria-label={label} title={label}>
      {PARTS.map(({ key, className }) => (
        <span
          key={key}
          aria-hidden
          className={counts[key] > 0 ? className : "text-muted-foreground/50"}
        >
          {counts[key]}
          {later(key) > 0 && (
            <sup className="ml-px text-[0.65em] text-muted-foreground">+{later(key)}</sup>
          )}
        </span>
      ))}
    </span>
  );
}
