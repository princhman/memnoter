import { useRouter } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import { useEffect } from "react";
import { guardSidebarSectionNavigation } from "@/lib/sidebar-sections";
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
  const { history } = useRouter();
  useEffect(() => {
    if (!editor || !ready) return;
    // The history blocker includes the request ID carried in navigation state.
    return history.block({
      enableBeforeUnload: false,
      blockerFn: async ({ nextLocation, action }) => {
        const request = guardSidebarSectionNavigation(nextLocation.state, action);
        if (request?.isSuperseded()) return true;
        try {
          await flushCardSyncs();
          return request?.isSuperseded() ?? false;
        } catch {
          if (!request?.isSuperseded()) {
            request?.cancel();
            window.alert("Could not save flashcards. Please try leaving the note again.");
          }
          return true;
        }
      },
    });
  }, [editor, ready, history]);

  return null;
}
