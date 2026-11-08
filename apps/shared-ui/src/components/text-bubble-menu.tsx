import { ToolButton } from "./ui/tool-button";
import { surfaceClass } from "./ui/surface";
import { action, formatKeys } from "@/lib/shortcuts";
import { isImageNode } from "../lib/cards.ts";
import { useRef, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { CellSelection } from "@tiptap/pm/tables";
import { TableControls } from "@/components/table-controls";
import { TableBubbleActions } from "@/components/table-bubble-actions";
import { TextSelection } from "@tiptap/pm/state";
import {
  Bold,
  Highlighter,
  ChevronDown,
  Braces,
  Combine,
  Code,
  Italic,
  Link,
  Radical,
  Sigma,
  Strikethrough,
  Underline,
} from "lucide-react";
import { HIGHLIGHT_COLORS, highlightColor } from "@/lib/highlight";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import { isLinkEditorOpen, TEXT_BUBBLE_MENU_KEY } from "@/lib/link-editor";

// Marks make no sense inside these; the menu stays hidden there. Inline
// math has its own actions on its preview.
const RAW_TEXT_NODES = new Set(["codeBlock", "mathBlock", "inlineMath"]);

export function TextBubbleMenu({ editor }: { editor: Editor | null }) {
  const pickerOpen = useRef(false);
  // The editor does not re-render on transactions, so track mark state here.
  const active = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor || editor.isDestroyed) return null;
      const { from, to } = editor.state.selection;
      let inlineMath = false;
      editor.state.doc.nodesBetween(from, to, (node) => {
        if (node.type.name === "inlineMath") inlineMath = true;
        return !inlineMath;
      });
      return {
        cells: editor.state.selection instanceof CellSelection,
        inTable: editor.isActive("table"),
        inlineMath,
        highlight: editor.isActive("highlight"),
        highlightColor: highlightColor(editor.getAttributes("highlight").color),
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        code: editor.isActive("code"),
        link: editor.isActive("link"),
        // Only a selection within one textblock converts to a math block.
        canMathBlock: editor.can().toggleMathBlock(),
        canMakeCard: editor.can().makeCloze(),
        canJoinClozes: editor.can().joinClozes(),
        inCloze: editor.can().removeCloze(),
      };
    },
  });

  if (!editor || !active) return null;

  return (
    <>
    <TableControls editor={editor} />
    <BubbleMenu
      editor={editor}
      role="toolbar"
      aria-label="Text formatting"
      pluginKey={TEXT_BUBBLE_MENU_KEY}
      // The default 250ms debounce makes the menu lag behind the selection.
      updateDelay={0}
      options={{ placement: "top", offset: 8, flip: true, shift: true }}
      shouldShow={({ editor, state, from, to }) => {
        const { selection } = state;
        if (!editor.isEditable || !editor.view.hasFocus() && !pickerOpen.current && !document.activeElement?.closest('[aria-label="Text formatting"]')) return false;
        // The link menu's URL field takes its place.
        if (isLinkEditorOpen(state)) return false;
        if (selection instanceof CellSelection) return true;
        if (!(selection instanceof TextSelection) || selection.empty) return false;
        if (!state.doc.textBetween(from, to).trim()) return false;

        let containsImage = false;
        state.doc.nodesBetween(from, to, (node) => {
          if (isImageNode(node)) containsImage = true;
          return !containsImage;
        });
        if (containsImage) return false;
        const { $from, $to } = selection;
        for (const $pos of [$from, $to]) {
          for (let depth = $pos.depth; depth > 0; depth--) {
            if (RAW_TEXT_NODES.has($pos.node(depth).type.name)) return false;
          }
        }
        return true;
      }}
      className={`${surfaceClass} z-40 flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-0.5 p-1`}
      // Keep the editor selection while clicking menu buttons.
      onMouseDown={(event) => event.preventDefault()}
    >
      {active.cells ? <TableBubbleActions editor={editor} /> : <>
      <MarkButton
        label="Bold"
        hint={formatKeys(action("text.bold").keys)}
        pressed={active.bold}
        onToggle={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold />
      </MarkButton>
      <MarkButton
        label="Italic"
        hint={formatKeys(action("text.italic").keys)}
        pressed={active.italic}
        onToggle={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </MarkButton>
      <MarkButton
        label="Underline"
        hint={formatKeys(action("text.underline").keys)}
        pressed={active.underline}
        onToggle={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline />
      </MarkButton>
      <MarkButton
        label="Strikethrough"
        hint={formatKeys(action("text.strike").keys)}
        pressed={active.strike}
        onToggle={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough />
      </MarkButton>
      <MarkButton
        label="Inline code"
        hint={formatKeys(action("text.code").keys)}
        pressed={active.code}
        onToggle={() => editor.chain().focus().toggleCode().run()}
      >
        <Code />
      </MarkButton>
      <div className="flex items-center">
        <IconTooltip label="Highlight" hint={formatKeys(action("text.highlight").keys)}>
          <Button size="icon-sm" variant="ghost" aria-label="Highlight" aria-pressed={active.highlight}
            className={active.highlight ? "note-highlight" : undefined}
            data-color={active.highlight ? active.highlightColor : undefined}
            onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter /></Button>
        </IconTooltip>
        <DropdownMenu onOpenChange={open => { pickerOpen.current = open; }}>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Highlight colours" />}>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-40" onMouseDown={event => event.preventDefault()}
            finalFocus={() => { editor.commands.focus(); return false; }}>
            {HIGHLIGHT_COLORS.map(color => <DropdownMenuItem key={color}
              onClick={() => editor.chain().focus().setHighlight({ color }).run()}>
              <span className="note-highlight size-4 rounded-sm" data-color={color} />
              {color[0].toUpperCase() + color.slice(1)}{active.highlight && active.highlightColor === color ? " ✓" : ""}
            </DropdownMenuItem>)}
            <DropdownMenuItem onClick={() => editor.chain().focus().unsetHighlight().run()}>Remove highlight</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <MarkButton
        label="Link"
        hint={formatKeys(action("link.edit").keys)}
        pressed={active.link}
        onToggle={() => editor.commands.openLinkEditor()}
      >
        <Link />
      </MarkButton>
      <MarkButton
        label="Inline math"
        hint={formatKeys(action("math.inline").keys)}
        pressed={active.inlineMath}
        onToggle={() => editor.chain().focus().toggleInlineMath().run()}
      >
        <Radical />
      </MarkButton>
      <MarkButton
        label="Math block"
        hint={formatKeys(action("math.block").keys)}
        pressed={false}
        disabled={!active.canMathBlock}
        onToggle={() => editor.chain().focus().toggleMathBlock().run()}
      >
        <Sigma />
      </MarkButton>
      <MarkButton
        label={active.inCloze ? "Remove cloze" : "Cloze"}
        hint={formatKeys(action("card.cloze").keys)}
        pressed={active.inCloze}
        disabled={!active.canMakeCard && !active.inCloze}
        onToggle={() =>
          active.inCloze
            ? editor.chain().focus().removeCloze().run()
            : editor.chain().focus().makeCloze().run()
        }
      >
        <Braces />
      </MarkButton>
      {active.canJoinClozes && (
        <MarkButton
          label="Join clozes"
          hint="Hide selected answers together on one card"
          pressed={false}
          onToggle={() => editor.chain().focus().joinClozes().run()}
        >
          <Combine />
        </MarkButton>
      )}
      {active.inTable && <TableBubbleActions editor={editor} />}
      </>}
    </BubbleMenu>
    </>
  );
}

function MarkButton({
  label,
  hint,
  pressed,
  disabled,
  onToggle,
  children,
}: {
  label: string;
  hint: string;
  pressed: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (<ToolButton label={label} hint={hint} pressed={pressed} disabled={disabled} onClick={onToggle}>{children}</ToolButton>);
}
