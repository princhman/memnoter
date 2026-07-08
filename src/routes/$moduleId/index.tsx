import Tiptap from "@/components/Tiptap";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$moduleId/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { moduleId } = Route.useParams();
  return <Tiptap key={moduleId} moduleId={moduleId} />;
}
