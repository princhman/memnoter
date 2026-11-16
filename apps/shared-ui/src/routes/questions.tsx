import { NoteWithPdfs } from "@/components/note-with-pdfs";
import { updatePdfPane, useAnyWorksheetOpen } from "@/lib/pdf-pane";
import { createFileRoute } from "@tanstack/react-router";
import { QuestionBank } from "@/components/question-bank";
import { useBankGate } from "@/lib/question-bank";
import { useModules } from "@/lib/modules";

export const Route = createFileRoute("/questions")({
  validateSearch: (search: Record<string, unknown>): { module?: string } =>
    typeof search.module === "string" ? { module: search.module } : {},
  component: Questions,
});

function Questions() {
  const { module: moduleId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const bankEnabled = useBankGate();
  const { data: modules = [], isPending, error } = useModules();
  // A worksheet takes the page: the header names it, so no module heading or other banks.
  const worksheetModule = useAnyWorksheetOpen();
  if (!bankEnabled) return <p className="text-center text-sm text-muted-foreground">Questions are not available.</p>;
  const scopedModules = modules.filter(module => moduleId ? module.id === moduleId : !worksheetModule || module.id === worksheetModule);
  if (moduleId && scopedModules.length) return <NoteWithPdfs moduleId={moduleId}>
    <QuestionBank moduleId={moduleId} onOpenSource={documentId => updatePdfPane(moduleId, { open: true, active: documentId })} />
  </NoteWithPdfs>;
  return <div className="app-scroll-container h-full overflow-y-auto"><div className="questions-all mx-auto w-full max-w-3xl space-y-8 px-4 py-4">
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
    {!isPending && !error && !scopedModules.length && <p className="text-sm text-muted-foreground">{moduleId ? "Module not found." : "Create a module to start collecting questions."}</p>}
    {!isPending && !error && scopedModules.length > 0 && !moduleId && !worksheetModule && <p className="questions-all-empty text-sm text-muted-foreground">Open a PDF and choose <span className="text-foreground">Crop question</span> to add questions.</p>}
    {scopedModules.map(module => <section key={module.id} className="questions-module" aria-label={module.name || "Untitled module"}>
      {!moduleId && !worksheetModule && <h2 className="mb-4 text-sm font-medium text-muted-foreground">{module.name || "Untitled module"}</h2>}
      <QuestionBank moduleId={module.id} hideWhenEmpty={!moduleId} onOpenSource={documentId => { void navigate({ to: "/questions", search: { module: module.id } }); updatePdfPane(module.id, { open: true, active: documentId }); }} />
    </section>)}
  </div></div>;
}
