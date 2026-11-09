import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Host } from "./host";

// The native shell owns module selection. These locations let the shared PDF
// reader use the same source links and note reveals while Host stays mounted.
const root = createRootRoute({ component: Host });
const empty = () => null;
const home = createRoute({ getParentRoute: () => root, path: "/", component: empty });
const note = createRoute({ getParentRoute: () => root, path: "/$moduleId", component: empty });
const reader = createRoute({ getParentRoute: () => root, path: "/files/$documentId", component: empty });

export const editorRouter = createRouter({
  routeTree: root.addChildren([home, note, reader]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
