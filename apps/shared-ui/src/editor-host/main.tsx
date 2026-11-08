import { Host } from "./host";
import { useEffect } from "react";
import { bootstrapNotes } from "@/lib/bootstrap";
import { onCardsChanged } from "@/lib/card-events";
import { postNativeEvent } from "@/lib/backend";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { queryClient } from "@/lib/query-client";
import "../App.css";
import "katex/dist/katex.min.css";
import "./host.css";

import "./theme";

// Keep this in the editor entry: review-native.html only renders card faces.
function CardBackfill() {
  useEffect(() => {
    const notify = () => postNativeEvent("cardsChanged");
    const stop = onCardsChanged(notify);
    void bootstrapNotes().then(notify).catch(error => console.error("Failed to initialize native notes:", error));
    return stop;
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ActiveEditorProvider><CardBackfill /><Host /></ActiveEditorProvider>
  </QueryClientProvider>,
);
