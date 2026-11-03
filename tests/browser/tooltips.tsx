import { createRoot } from "react-dom/client";
import { useState } from "react";
import { OcclusionEditor } from "@/components/occlusion-editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/App.css";
function Example() {
  const [open, setOpen] = useState(true);
  return <TooltipProvider>{open && <OcclusionEditor src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'/%3E" masks={[]} onCancel={() => setOpen(false)} onSave={() => setOpen(false)} />}</TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Example />);
