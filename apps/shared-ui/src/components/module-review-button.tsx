import { useOpenModuleId } from "@/lib/open-module";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useDueCounts } from "@/lib/card-sync";
import { CardCounts } from "@/components/card-counts";

// Reviews the open module's cards; shown beside the breadcrumbs.
export function ModuleReviewButton() {
  const moduleId = useOpenModuleId();
  const { forModule } = useDueCounts();
  if (!moduleId) return null;

  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground"
      nativeButton={false}
      render={<Link to="/review" search={{ module: moduleId }} />}
    >
      Review
      <CardCounts counts={forModule(moduleId)} />
    </Button>
  );
}
