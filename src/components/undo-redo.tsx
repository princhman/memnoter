import { useActiveEditor } from "@/lib/active-editor-context";
import { Button } from "./ui/button";
import { Redo2, Undo2 } from "lucide-react";
import { useEditorState } from "@tiptap/react";
import { IconTooltip } from "./icon-tooltip";
import { MOD_KEY } from "@/lib/utils";

export function UndoRedo() {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.editor ?? null;
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

  if (!editor || editor.isDestroyed) return null;

  return (
    <div>
      <IconTooltip label="Undo" hint={`${MOD_KEY}Z`} side="bottom">
        <Button
          size={"icon-sm"}
          variant={"ghost"}
          aria-label="Undo"
          disabled={!history?.canUndo}
          onClick={() => {
            if (!editor.isDestroyed) editor.chain().focus().undo().run();
          }}
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
          disabled={!history?.canRedo}
          onClick={() => {
            if (!editor.isDestroyed) editor.chain().focus().redo().run();
          }}
        >
          <Redo2 />
        </Button>
      </IconTooltip>
    </div>
  );
}
