import { action, formatKeys } from "@/lib/shortcuts";
import { useActiveEditor } from "@/lib/active-editor-context";
import { ToolButton } from "./ui/tool-button";
import { LocateFixed, Redo2, Undo2 } from "lucide-react";
import { useEditorState } from "@tiptap/react";
import { useSelector } from "@tanstack/react-store";
import { reviewActionsStore } from "@/lib/review-actions";

// Undo and redo for the open note, or for grades while reviewing, where an
// go-to action also opens the shown card in its note.
export function UndoRedo() {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.editor ?? null;
  const review = useSelector(reviewActionsStore, (state) => state);
  const history = useEditorState({
    editor,
    selector: ({ editor }) => {
      // A subscription can retain the previous editor during replacement.
      if (!editor || editor.isDestroyed) {
        return { canUndo: false, canRedo: false };
      }

      const commands = editor.can();
      return { canUndo: commands.undo(), canRedo: commands.redo() };
    },
  });

  if (editor && !editor.isDestroyed) {
    return (
      <HistoryButtons
        canUndo={!!history?.canUndo}
        canRedo={!!history?.canRedo}
        onUndo={() => {
          if (!editor.isDestroyed) editor.chain().focus().undo().run();
        }}
        onRedo={() => {
          if (!editor.isDestroyed) editor.chain().focus().redo().run();
        }}
      />
    );
  }

  if (!review) return null;

  return (
    <HistoryButtons
      canUndo={review.canUndo}
      canRedo={review.canRedo}
      onUndo={review.undo}
      onRedo={review.redo}
    >
      <ToolButton label="Go to card in note" side="bottom"
          disabled={!review.edit}
          onClick={() => review.edit?.()}
        >
          <LocateFixed />
        </ToolButton>
    </HistoryButtons>
  );
}

function HistoryButtons({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  children,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <ToolButton label="Undo" hint={formatKeys(action("history.undo").keys)} side="bottom"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 />
        </ToolButton>
      <ToolButton label="Redo"
        hint={formatKeys(action("history.redo").keys)}
        side="bottom"

          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 />
        </ToolButton>
      {children}
    </div>
  );
}
