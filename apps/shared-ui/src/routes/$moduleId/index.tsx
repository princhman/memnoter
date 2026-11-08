import { openReview } from "@/components/card-navigation-guard";
import { useCommand } from "@/lib/commands";
import Tiptap from "@/components/Tiptap";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$moduleId/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { moduleId } = Route.useParams();
  const navigate = Route.useNavigate();
  useCommand({ id: "review.module", title: "Review this module", keywords: ["flashcards"],
    run: () => openReview(() => navigate({ to: "/review", search: { module: moduleId } })),
  });
  return <Tiptap key={moduleId} moduleId={moduleId} />;
}
