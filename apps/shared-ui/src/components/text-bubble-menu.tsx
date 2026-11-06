import type { ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { TextSelection } from "@tiptap/pm/state";
import {
  Bold,
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
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import { isLinkEditorOpen, TEXT_BUBBLE_MENU_KEY } from "@/lib/link-editor";
import { cn, MOD_KEY } from "@/lib/utils";

// Marks make no sense inside these; the menu stays hidden there. Inline
// math has its own actions on its preview.
const RAW_TEXT_NODES = new Set(["codeBlock", "mathBlock", "inlineMath"]);

export function TextBubbleMenu({ editor }: { editor: Editor | null }) {
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
        inlineMath,
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
        if (!editor.isEditable || !editor.view.hasFocus()) return false;
        // The link menu's URL field takes its place.
        if (isLinkEditorOpen(state)) return false;
        if (!(selection instanceof TextSelection) || selection.empty) return false;
        if (!state.doc.textBetween(from, to).trim()) return false;

        let containsImage = false;
        state.doc.nodesBetween(from, to, (node) => {
          if (node.type.name === "image" || node.type.name === "inlineImage") containsImage = true;
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
      className="z-40 flex items-center gap-0.5 rounded-lg floating-surface bg-popover p-1 text-popover-foreground shadow-md"
      // Keep the editor selection while clicking menu buttons.
      onMouseDown={(event) => event.preventDefault()}
    >
      <MarkButton
        label="Bold"
        hint={`${MOD_KEY}B`}
        pressed={active.bold}
        onToggle={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold />
      </MarkButton>
      <MarkButton
        label="Italic"
        hint={`${MOD_KEY}I`}
        pressed={active.italic}
        onToggle={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </MarkButton>
      <MarkButton
        label="Underline"
        hint={`${MOD_KEY}U`}
        pressed={active.underline}
        onToggle={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline />
      </MarkButton>
      <MarkButton
        label="Strikethrough"
        hint={`${MOD_KEY}Shift+S`}
        pressed={active.strike}
        onToggle={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough />
      </MarkButton>
      <MarkButton
        label="Inline code"
        hint={`${MOD_KEY}E`}
        pressed={active.code}
        onToggle={() => editor.chain().focus().toggleCode().run()}
      >
        <Code />
      </MarkButton>
      <MarkButton
        label="Link"
        hint={`${MOD_KEY}L`}
        pressed={active.link}
        onToggle={() => editor.commands.openLinkEditor()}
      >
        <Link />
      </MarkButton>
      <MarkButton
        label="Inline math"
        hint={`${MOD_KEY}Shift+M`}
        pressed={active.inlineMath}
        onToggle={() => editor.chain().focus().toggleInlineMath().run()}
      >
        <Radical />
      </MarkButton>
      <MarkButton
        label="Math block"
        hint={`${MOD_KEY}Alt+M`}
        pressed={false}
        disabled={!active.canMathBlock}
        onToggle={() => editor.chain().focus().toggleMathBlock().run()}
      >
        <Sigma />
      </MarkButton>
      <MarkButton
        label={active.inCloze ? "Remove cloze" : "Cloze"}
        hint={`${MOD_KEY}${MOD_KEY === "⌘" ? "⇧" : "Shift+"}C`}
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
    </BubbleMenu>
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
  return (
    <IconTooltip label={label} hint={hint}>
<Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            className={cn(
              pressed && "bg-primary/15 text-primary hover:bg-primary/20 dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/80 dark:hover:text-primary-foreground",
            )}
            onClick={onToggle}
          >
{children}
</Button>
</IconTooltip>
  );
}
