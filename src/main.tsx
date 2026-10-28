import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { checkForUpdates } from "./lib/updater";
import { listenToMenu } from "./lib/app-events";
import "./App.css";
import "katex/dist/katex.min.css";

function syncThemeWithSystem() {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

  const applyTheme = () => {
    const isDark = mediaQuery.matches;

    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  };

  applyTheme();
  mediaQuery.addEventListener("change", applyTheme);

  return () => {
    mediaQuery.removeEventListener("change", applyTheme);
  };
}

syncThemeWithSystem();
void checkForUpdates();
listenToMenu();

const queryClient = new QueryClient();
const router = createRouter({ routeTree });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
