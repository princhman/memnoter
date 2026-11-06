import { useEditorState, type Editor } from "@tiptap/react";
import { Columns3, Rows3, Merge, Split, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";

const actions = [
  ["Merge cells", "mergeCells", Merge],
  ["Split cell", "splitCell", Split],
  ["Add row below", "addRowAfter", Rows3],
  ["Add column right", "addColumnAfter", Columns3],
  ["Delete row", "deleteRow", Rows3],
  ["Delete column", "deleteColumn", Columns3],
  ["Delete table", "deleteTable", Trash2],
] as const;

export function TableBubbleActions({ editor }: { editor: Editor }) {
  const enabled = useEditorState({ editor, selector: ({ editor }) =>
    actions.map(([, command]) => editor.can()[command]()),
  });
  return actions.map(([label, command, Icon], index) => (
    <IconTooltip key={command} label={label}>
      <Button size="icon-sm" variant="ghost" aria-label={label}
        disabled={!enabled[index]} onClick={() => editor.chain().focus()[command]().run()}>
        <Icon />
      </Button>
    </IconTooltip>
  ));
}
