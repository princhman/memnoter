import { useBlocker } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import { pendingSidebarAddCancellation } from "@/lib/sidebar-sections";
import { flushCardSyncs } from "@/lib/card-sync";

// Palette actions share the same flush/error behavior as blocked navigation.
export async function openReview(navigate: () => Promise<unknown>) {
  try {
    await navigate();
  } catch (error) {
    window.alert("Could not open review. Please retry saving flashcards first.");
    console.error("Failed to open review:", error);
  }
}

// Desktop navigation waits for card ID repair before unmounting the editor.
export function CardNavigationGuard({ editor, ready }: { editor: Editor | null; ready: boolean }) {
  // Keep the editor alive until copied ids have been repaired and resynced.
  useBlocker({
    disabled: !editor || !ready,
    enableBeforeUnload: false,
    shouldBlockFn: async ({ next }) => {
      const cancelAdd = pendingSidebarAddCancellation(next.pathname);
      try {
        await flushCardSyncs();
        return false;
      } catch {
        cancelAdd?.();
        window.alert("Could not save flashcards. Please try leaving the note again.");
        return true;
      }
    },
  });

  return null;
}
