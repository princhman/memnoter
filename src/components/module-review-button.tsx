import { Link, useMatchRoute } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDueCounts } from "@/lib/card-sync";
import { CardCounts } from "@/components/card-counts";

// Reviews the open module's cards; shown beside the breadcrumbs.
export function ModuleReviewButton() {
  const matchRoute = useMatchRoute();
  const { forModule } = useDueCounts();
  // These pages also match the module id pattern.
  const isPage = !!matchRoute({ to: "/settings" }) || !!matchRoute({ to: "/review" });
  const match = matchRoute({ to: "/$moduleId" });
  if (!match || isPage) return null;

  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground"
      nativeButton={false}
      render={<Link to="/review" search={{ module: match.moduleId }} />}
    >
      <Layers />
      Review
      <CardCounts counts={forModule(match.moduleId)} />
    </Button>
  );
}
