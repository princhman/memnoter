import "@/App.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { queryClient } from "@/lib/query-client";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { PdfRegionSelection } from "@/components/pdf-region-selection";
import { PdfViewer } from "@/components/pdf-viewer";
import type { PdfRegion } from "@/lib/pdf-quote";

function Fixture() {
  const [readerMounted, setReaderMounted] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [width, setWidth] = useState(200);
  const [generation, setGeneration] = useState(0);
  const [regions, setRegions] = useState<PdfRegion[]>([]);
  const [cancelled, setCancelled] = useState(0);
  const pending = useSelector(pendingPdfQuote, value => value);
  const [crop, setCrop] = useState<object | null>(null);
  useEffect(() => {
    setCrop(null);
    if (!pending) return;
    void createImageBitmap(pending.file).then(bitmap => {
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
      setCrop({ width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(0, 0, 1, 1).data], source: pending.source });
      bitmap.close();
    }).catch(() => {});
  }, [pending]);
  return <>
    <button onClick={() => setReaderMounted(value => !value)}>Toggle reader mount</button>
    <button onClick={() => setMounted(value => !value)}>Toggle selection mount</button>
    <button onClick={() => setWidth(value => value === 200 ? 300 : 200)}>Resize page</button>
    <button onClick={() => setGeneration(value => value + 1)}>Replace page</button>
    <button onClick={() => pendingPdfQuote.setState(() => null)}>Clear quote</button>
    <button onClick={() => pendingPdfQuote.setState(() => ({ moduleId: "other", file: new File(["existing"], "existing.png"), source: { documentId: "other", name: "Existing.pdf", page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }, section: true, status: "draft" }))}>Stage other quote</button>
    <div hidden><output id="regions">{JSON.stringify(regions)}</output><output id="cancelled">{cancelled}</output>
    <output id="crop">{JSON.stringify(crop)}</output><output id="pending">{pending?.source.name ?? "none"}</output></div>
    <div id="selection-sandbox" style={{ position: "relative", width, height: 100, margin: 20 }}>
      {mounted && <PdfRegionSelection key={generation} onSelect={region => setRegions(previous => [...previous, region])} onCancel={() => setCancelled(value => value + 1)} />}
    </div>
    <div id="viewer" style={{ height: 500 }}>{readerMounted && <PdfViewer doc={{ id: "selection-pdf", moduleId: "module", moduleName: "Module", name: "Selection.pdf", size: 1000, pageCount: 6, createdAt: 0, available: true }} />}</div>
  </>;
}
const route = createRootRoute({ component: Fixture });
const router = createRouter({ routeTree: route });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
