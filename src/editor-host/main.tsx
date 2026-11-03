import { Host } from "./host";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { queryClient } from "@/lib/query-client";
import "../App.css";
import "katex/dist/katex.min.css";
import "./host.css";
import { fitToVisibleViewport } from "@/lib/platform";

fitToVisibleViewport();
const theme = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => {
  document.documentElement.classList.toggle("dark", theme.matches);
  document.documentElement.style.colorScheme = theme.matches ? "dark" : "light";
};
theme.addEventListener("change", applyTheme);
applyTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ActiveEditorProvider><Host /></ActiveEditorProvider>
  </QueryClientProvider>,
);
