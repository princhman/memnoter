import { useSelector } from "@tanstack/react-store";
import { Button } from "@/components/ui/button";
import { useOpenModuleId } from "@/lib/open-module";
import { updatePdfPane } from "@/lib/pdf-pane";
import { bankView, useBankGate } from "@/lib/question-bank";

// Switches the open module between its notes and its question bank; shown
// beside Review.
export function ModuleBankButton() {
  const moduleId = useOpenModuleId();
  const enabled = useBankGate();
  const showing = useSelector(bankView, s => !!moduleId && s === moduleId);
  if (!moduleId || !enabled) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => {
        if (showing) { bankView.setState(() => null); return; }
        bankView.setState(() => moduleId);
        updatePdfPane(moduleId, { open: true });
      }}
    >
      {showing ? "Notes" : "Question bank"}
    </Button>
  );
}
