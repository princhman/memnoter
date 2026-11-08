import { memo } from "react";
import type { PdfRegion } from "@/lib/pdf-quote";

/** Mount inside the page's relative CSS rectangle, alongside its canvas. */
export const PdfQuoteRegions = memo(function PdfQuoteRegions({ regions }: { regions: readonly PdfRegion[] | undefined }) {
  if (!regions?.length) return null;
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0">
    {regions.map(region => <div
      key={`${region.x},${region.y},${region.width},${region.height}`}
      className="pointer-events-none absolute border border-primary/40 bg-primary/5"
      style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
    />)}
  </div>;
});
