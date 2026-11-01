import { Link, useMatchRoute } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDueCounts } from "@/lib/card-sync";

// Reviews the open module's cards; shown beside the breadcrumbs.
export function ModuleReviewButton() {
  const matchRoute = useMatchRoute();
  const { byModule } = useDueCounts();
  // These pages also match the module id pattern.
  const isPage = !!matchRoute({ to: "/settings" }) || !!matchRoute({ to: "/review" });
  const match = matchRoute({ to: "/$moduleId" });
  if (!match || isPage) return null;

  const due = byModule.get(match.moduleId) ?? 0;
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
      {due > 0 && <span className="tabular-nums">{due}</span>}
    </Button>
  );
}
