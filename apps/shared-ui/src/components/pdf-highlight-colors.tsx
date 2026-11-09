import { Check } from "lucide-react";
import { PDF_ANNOTATION_COLORS, type PdfAnnotationColor } from "@/lib/pdf-annotations";
import { ToolButton } from "./ui/tool-button";

export const pdfHighlightColors = {
  primary: { label: "Purple", value: "var(--primary)" },
  yellow: { label: "Yellow", value: "var(--color-yellow-400)" },
  green: { label: "Green", value: "var(--color-emerald-400)" },
  blue: { label: "Blue", value: "var(--color-sky-400)" },
  pink: { label: "Pink", value: "var(--color-pink-400)" },
} satisfies Record<PdfAnnotationColor, { label: string; value: string }>;

export function PdfHighlightColors({ color, disabled, onChange }: {
  color: PdfAnnotationColor;
  disabled?: boolean;
  onChange: (color: PdfAnnotationColor) => void;
}) {
  return <div role="group" aria-label="Highlight colours" className="flex items-center gap-1">
    {PDF_ANNOTATION_COLORS.map(option => <ToolButton key={option} size="icon-xs" label={`${pdfHighlightColors[option].label} highlight`} pressed={option === color} disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => onChange(option)}>
      <span className={`flex size-4 items-center justify-center rounded-full ${option === "primary" ? "text-primary-foreground" : "text-black"}`} style={{ backgroundColor: pdfHighlightColors[option].value }}>{option === color && <Check className="size-3" aria-hidden="true" />}</span>
    </ToolButton>)}
  </div>;
}
