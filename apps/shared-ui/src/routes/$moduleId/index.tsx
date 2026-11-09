import { NoteWithPdfs } from "@/components/note-with-pdfs";
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
  return <NoteWithPdfs key={moduleId} moduleId={moduleId}><Tiptap moduleId={moduleId} /></NoteWithPdfs>;
}
