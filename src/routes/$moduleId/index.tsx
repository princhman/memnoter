import { openReview } from "@/lib/card-sync";
import { useCommand } from "@/lib/commands";
import Tiptap from "@/components/Tiptap";
import { Button } from "@/components/ui/button";
import { useDueCounts } from "@/lib/card-sync";
import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$moduleId/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { moduleId } = Route.useParams();
  const { byModule } = useDueCounts();
  const navigate = Route.useNavigate();
  useCommand({ id: "review.module", title: "Review this module", keywords: ["flashcards"],
    run: () => openReview(() => navigate({ to: "/review", search: { module: moduleId } })),
  });
  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/review" search={{ module: moduleId }} />}
        >
          Review ({byModule.get(moduleId) ?? 0} due)
        </Button>
      </div>
      <Tiptap key={moduleId} moduleId={moduleId} />
    </>
  );
}
