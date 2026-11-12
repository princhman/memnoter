import { ToolButton } from "./ui/tool-button";
import { surfaceClass } from "./ui/surface";
import { action, formatKeys } from "@/lib/shortcuts";
import { isImageNode } from "../lib/cards.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { posToDOMRect } from "@tiptap/core";
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
  Group,
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
import { isLinkEditorOpen, TEXT_BUBBLE_MENU_KEY } from "@/lib/link-editor";

// Marks make no sense inside these; the menu stays hidden there. Inline
// math has its own actions on its preview.
const RAW_TEXT_NODES = new Set(["codeBlock", "mathBlock", "inlineMath"]);

export function TextBubbleMenu({ editor }: { editor: Editor | null }) {
  const pickerOpen = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const [menuContainer] = useState(() => document.createElement("div"));
  useEffect(() => {
    // TipTap uses the menu parent's containment to decide whether focus left it.
    const parent = editor?.view.dom.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.appendChild(menuContainer);
    return () => menuContainer.remove();
  }, [editor, menuContainer]);
  const anchor = useRef<{ hidden: boolean } | null>(null);

  useEffect(() => {
    if (!editor) return;
    anchor.current = null;
    // Capture also sees scrolls in the desktop note pane and nested editors.
    const update = () => {
      if (!editor.isDestroyed && menu.current) {
        const rect = posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to);
        let top = 0, bottom = window.innerHeight;
        for (let parent = editor.view.dom.parentElement; parent; parent = parent.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
            const bounds = parent.getBoundingClientRect();
            top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
          }
        }
        const hidden = rect.bottom <= top || rect.top >= bottom;
        menu.current.style.visibility = hidden ? "hidden" : "visible";
        if (hidden) return;
        // The menu scrolls natively with the text; re-place it only when it
        // must flip: above the selection but cut off at the top, or below it
        // with room above again.
        const box = menu.current.getBoundingClientRect();
        const above = box.bottom <= rect.top;
        if (above ? box.top < top : rect.top - box.height - 8 >= top) {
          editor.view.dispatch(editor.state.tr.setMeta(TEXT_BUBBLE_MENU_KEY, "updatePosition"));
        }
      }
    };
    document.addEventListener("scroll", update, true);
    return () => document.removeEventListener("scroll", update, true);
  }, [editor]);
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
        canMakeClozeNote: editor.can().makeClozeNote(),
        inCloze: editor.can().removeCloze(),
        inMathBlock: editor.state.selection.$from.sameParent(editor.state.selection.$to) &&
          editor.state.selection.$from.parent.type.name === "mathBlock",
      };
    },
  });

  if (!editor || !active) return null;

  const clozeButton = (
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
  );

  return (
    <>
    <TableControls editor={editor} />
    <BubbleMenu
      editor={editor}
      ref={menu}
      appendTo={menuContainer}
      getReferencedVirtualElement={() => {
        const { state, view } = editor;
        let live = posToDOMRect(view, state.selection.from, state.selection.to);
        if (state.selection instanceof CellSelection) {
          const { $anchorCell, $headCell } = state.selection;
          const first = (view.nodeDOM($anchorCell.pos) as HTMLElement | null)?.getBoundingClientRect();
          const last = (view.nodeDOM($headCell.pos) as HTMLElement | null)?.getBoundingClientRect();
          if (first && last) {
            const left = Math.min(first.left, last.left), top = Math.min(first.top, last.top);
            live = new DOMRect(left, top, Math.max(first.right, last.right) - left, Math.max(first.bottom, last.bottom) - top);
          }
        }
        let top = 0, left = 0, bottom = window.innerHeight, right = window.innerWidth;
        for (let parent = view.dom.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const bounds = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
          }
        }
        const hidden = live.bottom <= top || live.top >= bottom || live.right <= left || live.left >= right;
        anchor.current = { hidden };
        return { contextElement: view.dom, getBoundingClientRect: () => live };
      }}
      role="toolbar"
      aria-label="Text formatting"
      pluginKey={TEXT_BUBBLE_MENU_KEY}
      // The default 250ms debounce makes the menu lag behind the selection.
      updateDelay={0}
      options={{
        strategy: "absolute", scrollTarget: menuContainer, placement: "top", offset: 8, flip: true, shift: true,
        onUpdate: () => {
          if (menu.current && anchor.current?.hidden) menu.current.style.visibility = "hidden";
        },
        onHide: () => { anchor.current = null; },
      }}
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
        // A selection in one formula offers only to make it a cloze.
        if ($from.sameParent($to) && $from.parent.type.name === "mathBlock") return true;
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
      {active.cells ? <TableBubbleActions editor={editor} /> : active.inMathBlock ? clozeButton : <>
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
        <MarkButton
          label="Highlight"
          hint={formatKeys(action("text.highlight").keys)}
          pressed={active.highlight}
          onToggle={() => editor.chain().focus().toggleHighlight().run()}
        >
          <Highlighter />
        </MarkButton>
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
      {clozeButton}
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
      {active.canMakeClozeNote && (
        <MarkButton
          label="Make one note"
          hint="Show these blocks together on each of their cloze cards"
          pressed={false}
          onToggle={() => editor.chain().focus().makeClozeNote().run()}
        >
          <Group />
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
  return (<ToolButton label={label} hint={hint} pressed={pressed} variant={pressed ? "default" : "ghost"} disabled={disabled} onClick={onToggle}>{children}</ToolButton>);
}
