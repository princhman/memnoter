import "@/App.css";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { queryClient } from "@/lib/query-client";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { NoteWithPdfs } from "@/components/note-with-pdfs";
import { updatePdfPane } from "@/lib/pdf-pane";
const params = new URLSearchParams(location.search);
const moduleId = params.get("module")!;
updatePdfPane(moduleId, { open: true, active: params.get("pdf"), width: 560 });
function Fixture() { return <ActiveEditorProvider><div style={{ height: "100vh" }}><NoteWithPdfs moduleId={moduleId}><p>Notes for this test module</p></NoteWithPdfs></div></ActiveEditorProvider>; }
const root = createRootRoute({ component: Fixture });
const router = createRouter({ routeTree: root });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
