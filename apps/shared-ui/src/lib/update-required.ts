import { createStore } from "@tanstack/react-store";
import { UPDATE_REQUIRED_MESSAGE } from "./sync/protocol.ts";

export const updateRequiredStore = createStore(false);
export function reportSyncRefusal(message: string, status?: number) {
  if (status === 426 || message === UPDATE_REQUIRED_MESSAGE) updateRequiredStore.setState(() => true);
}
