import type { CardCounts as Counts } from "@/lib/card-sync";
import { cn } from "@/lib/utils";

const PARTS = [
  { key: "new", label: "new", className: "text-sky-600 dark:text-sky-400" },
  { key: "learning", label: "learning", className: "text-red-600 dark:text-red-400" },
  { key: "review", label: "to review", className: "text-emerald-600 dark:text-emerald-400" },
] as const;

// Cards due now as Anki shows them: new, learning and to review, each in its
// own colour, with zeros faded. Cards due later today follow as a faded +n.
export function CardCounts({ counts, className }: { counts: Counts; className?: string }) {
  const later = counts.laterToday ?? 0;
  const label = [
    ...PARTS.map(({ key, label }) => `${counts[key]} ${label}`),
    ...(later > 0 ? [`${later} more due later today`] : []),
  ].join(", ");
  return (
    <span className={cn("inline-flex gap-1.5 tabular-nums", className)} aria-label={label} title={label}>
      {PARTS.map(({ key, className }) => (
        <span
          key={key}
          aria-hidden
          className={counts[key] > 0 ? className : "text-muted-foreground/50"}
        >
          {counts[key]}
        </span>
      ))}
      {later > 0 && (
        <span aria-hidden className="text-muted-foreground">
          +{later}
        </span>
      )}
    </span>
  );
}
