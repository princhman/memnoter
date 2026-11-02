import { QueryClient } from "@tanstack/react-query";

// Shared with code outside React, such as the save queue.
export const queryClient = new QueryClient({
  defaultOptions: {
    // Local IPC must run even when the webview reports no network connection.
    queries: { networkMode: "always" },
    mutations: { networkMode: "always" },
  },
});
