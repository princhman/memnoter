import { Toaster } from "@/components/ui/sonner";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { checkForUpdates } from "./lib/updater";
import { listenToMenu } from "./lib/app-events";
import { queryClient } from "./lib/query-client";
import { fitToVisibleViewport } from "./lib/platform";
import "./App.css";
import "katex/dist/katex.min.css";

import "./editor-host/theme";

fitToVisibleViewport();
void checkForUpdates();
listenToMenu();

const router = createRouter({ routeTree });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
