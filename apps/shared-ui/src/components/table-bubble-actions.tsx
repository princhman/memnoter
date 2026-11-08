import { useEditorState, type Editor } from "@tiptap/react";
import { Columns3, Rows3, Minus, BetweenHorizontalStart, BetweenHorizontalEnd, BetweenVerticalStart, BetweenVerticalEnd, Merge, Split, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";

// Each "between" icon draws two blocks; the filled one is where the new row
// or column goes (first: above/left, last: below/right).
const actions = [
  ["Merge cells", "mergeCells", <Merge />],
  ["Split cell", "splitCell", <Split />],
  ["Add row above", "addRowBefore", <BetweenHorizontalStart className="table-add-icon" data-new="first" />],
  ["Add row below", "addRowAfter", <BetweenHorizontalEnd className="table-add-icon" data-new="last" />],
  ["Add column left", "addColumnBefore", <BetweenVerticalStart className="table-add-icon" data-new="first" />],
  ["Add column right", "addColumnAfter", <BetweenVerticalEnd className="table-add-icon" data-new="last" />],
  ["Delete row", "deleteRow", <span className="table-delete-icon"><Rows3 /><Minus /></span>],
  ["Delete column", "deleteColumn", <span className="table-delete-icon"><Columns3 /><Minus /></span>],
  ["Delete table", "deleteTable", <Trash2 />],
] as const;

export function TableBubbleActions({ editor }: { editor: Editor }) {
  const enabled = useEditorState({ editor, selector: ({ editor }) =>
    actions.map(([, command]) => editor.can()[command]()),
  });
  return actions.map(([label, command, icon], index) => (
    (command === "mergeCells" || command === "splitCell") && !enabled[index] ? null :
    <IconTooltip key={command} label={label}>
      <Button size="icon-sm" variant="ghost" aria-label={label}
        disabled={!enabled[index]} onClick={() => editor.chain().focus()[command]().run()}>
        {icon}
      </Button>
    </IconTooltip>
  ));
}
