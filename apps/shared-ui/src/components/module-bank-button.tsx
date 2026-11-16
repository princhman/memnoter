import { Button } from "@/components/ui/button";
import { useOpenModuleId } from "@/lib/open-module";
import { updatePdfPane } from "@/lib/pdf-pane";
import { useBankGate } from "@/lib/question-bank";
import { setModulePage, useModulePage } from "@/lib/store";

// Switches the open module between its notes and its question bank; shown
// beside Review.
export function ModuleBankButton() {
  const moduleId = useOpenModuleId();
  const enabled = useBankGate();
  const showing = useModulePage(moduleId) === "questions";
  if (!moduleId || !enabled) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => {
        if (showing) { setModulePage(moduleId, "notes"); return; }
        setModulePage(moduleId, "questions");
        updatePdfPane(moduleId, { open: true });
      }}
    >
      {showing ? "Notes" : "Question bank"}
    </Button>
  );
}
