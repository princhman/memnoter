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
