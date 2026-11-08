import palette from './review-palette.json';
import type { Grade } from './fsrs';
import type { CardCountKind } from './card-count-kind';
export const COUNT_PARTS = palette.counts as (Omit<typeof palette.counts[number], 'key'> & { key: CardCountKind })[];
export const GRADE_STYLES = Object.fromEntries(palette.grades.map((grade, index) => [index + 1, grade.className])) as Record<Grade, string>;

export function reviewCountsLabel(counts: { new: number; learning: number; review: number; laterToday?: { new: number; learning: number; review: number } }, current?: CardCountKind | null) {
  return COUNT_PARTS.map(({ key, label }) => {
    const later = counts.laterToday?.[key] ?? 0;
    return `${counts[key]} ${label}${later > 0 ? ` (+${later} later today)` : ""}`;
  }).join(", ") + (current ? `, reviewing ${COUNT_PARTS.find(part => part.key === current)?.label}` : "");
}
