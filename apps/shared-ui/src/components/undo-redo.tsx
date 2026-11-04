import { useActiveEditor } from "@/lib/active-editor-context";
import { Button } from "./ui/button";
import { LocateFixed, Pencil, Redo2, Undo2 } from "lucide-react";
import { useEditorState } from "@tiptap/react";
import { useSelector } from "@tanstack/react-store";
import { IconTooltip } from "./icon-tooltip";
import { MOD_KEY } from "@/lib/utils";
import { reviewActionsStore } from "@/lib/review-actions";

// Undo and redo for the open note, or for grades while reviewing, where an
// Edit button also opens the shown card in its note.
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
      <IconTooltip label="Edit card" side="bottom">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Edit card"
          disabled={!review.edit}
          onClick={() => review.edit?.()}
        >
          <Pencil />
        </Button>
      </IconTooltip>
      <IconTooltip label="Go to card in note" side="bottom">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Go to card in note"
          disabled={!review.edit}
          onClick={() => review.edit?.()}
        >
          <LocateFixed />
        </Button>
      </IconTooltip>
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
      <IconTooltip label="Undo" hint={`${MOD_KEY}Z`} side="bottom">
        <Button
          size={"icon-sm"}
          variant={"ghost"}
          aria-label="Undo"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 />
        </Button>
      </IconTooltip>
      <IconTooltip
        label="Redo"
        hint={`${MOD_KEY}${MOD_KEY === "⌘" ? "⇧" : "Shift+"}Z`}
        side="bottom"
      >
        <Button
          size={"icon-sm"}
          variant={"ghost"}
          aria-label="Redo"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 />
        </Button>
      </IconTooltip>
      {children}
    </div>
  );
}
