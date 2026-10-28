import { QueryClient } from "@tanstack/react-query";

// Shared with code outside React, such as the save queue.
export const queryClient = new QueryClient();
