import { Host } from "./host";
import { useEffect } from "react";
import { bootstrapNotes } from "@/lib/bootstrap";
import { dueCountsKey } from "@/lib/card-sync";
import { postNativeEvent } from "@/lib/backend";
import ReactDOM from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { queryClient } from "@/lib/query-client";
import "../App.css";
import "katex/dist/katex.min.css";
import "./host.css";

import "./theme";

// Keep this in the editor entry: review-native.html only renders card faces.
function CardBackfill() {
  // Retain the key while the host lives; an unobserved cache entry is collected
  // after five minutes, which would lose later synced-note notifications.
  useQuery({ queryKey: dueCountsKey, queryFn: () => null, initialData: null, enabled: false });
  useEffect(() => {
    let refresh: number | undefined;
    const notify = () => {
      window.clearTimeout(refresh);
      refresh = window.setTimeout(() => postNativeEvent("cardsChanged"), 100);
    };
    // Includes the shared synced-note reindexer and the visible editor, whose
    // React Query invalidations otherwise never reach native due counts.
    const stop = queryClient.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "invalidate" &&
          dueCountsKey.every((key, index) => event.query.queryKey[index] === key)) notify();
    });
    const start = window.setTimeout(() => { void bootstrapNotes().then(notify); }, 0);
    return () => { stop(); window.clearTimeout(start); window.clearTimeout(refresh); };
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ActiveEditorProvider><CardBackfill /><Host /></ActiveEditorProvider>
  </QueryClientProvider>,
);
