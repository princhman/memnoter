import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { queryClient } from "@/lib/query-client";
import "../App.css";
import "katex/dist/katex.min.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ActiveEditorProvider><main className="app-scroll-container h-full overflow-y-auto p-4" /></ActiveEditorProvider>
  </QueryClientProvider>,
);
