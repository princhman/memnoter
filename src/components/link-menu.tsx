import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { TextSelection } from "@tiptap/pm/state";
import { Check, ExternalLink, Pencil, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isLinkEditorOpen,
  LINK_MENU_KEY,
  normalizeHref,
  openLink,
} from "@/lib/link-editor";
import { MOD_KEY } from "@/lib/utils";

// The URL field opened with ⌘L or the bubble menu, and, with the caret in a
// link, a strip to open, edit or remove it.
export function LinkMenu({ editor }: { editor: Editor | null }) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor || editor.isDestroyed) return null;
      const { from, to } = editor.state.selection;
      return {
        editing: isLinkEditorOpen(editor.state),
        href: (editor.getAttributes("link").href as string | undefined) ?? null,
        // Remounts the field for each opening, so it starts from the link.
        key: `${from}:${to}`,
      };
    },
  });

  if (!editor || !state) return null;

  const close = () => {
    // Focus brings back the selection's bubble menu, if it has one.
    editor.chain().closeLinkEditor().focus().run();
  };
  const hide = () => {
    editor
      .chain()
      .closeLinkEditor()
      .command(({ tr }) => {
        tr.setMeta(LINK_MENU_KEY, "hide");
        return true;
      })
      .run();
  };

  const apply = (input: string) => {
    const href = normalizeHref(input);
    const chain = editor.chain().focus().closeLinkEditor();
    if (!href) {
      chain.extendMarkRange("link").unsetLink();
    } else if (editor.state.selection.empty && !state.href) {
      chain.insertContent({
        type: "text",
        text: input.trim(),
        marks: [{ type: "link", attrs: { href } }],
      });
    } else {
      chain.extendMarkRange("link").setLink({ href });
    }
    // The caret goes after the link, and what is typed next is not linked.
    chain
      .command(({ tr }) => {
        tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
        return true;
      })
      .unsetMark("link")
      .run();
  };

  const remove = () =>
    editor.chain().focus().closeLinkEditor().extendMarkRange("link").unsetLink().run();

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={LINK_MENU_KEY}
      updateDelay={0}
      options={{ placement: "bottom", offset: 8, flip: true, shift: true }}
      shouldShow={({ editor, view, state }) => {
        if (!editor.isEditable) return false;
        if (isLinkEditorOpen(state)) return true;
        return view.hasFocus() && state.selection.empty && editor.isActive("link");
      }}
      className="z-40 flex items-center gap-0.5 rounded-lg bg-popover p-1 text-popover-foreground shadow-md"
    >
      {state.editing ? (
        <LinkField
          key={state.key}
          initial={state.href ?? ""}
          canRemove={!!state.href}
          onApply={apply}
          onRemove={remove}
          onCancel={close}
          onLeave={hide}
        />
      ) : (
        state.href && (
          // Buttons keep the editor's caret where it is.
          <div
            className="flex items-center gap-0.5"
            onMouseDown={(event) => event.preventDefault()}
          >
            <span className="max-w-60 truncate px-1.5 text-xs text-muted-foreground">
              {state.href}
            </span>
            <IconButton
              label="Open link"
              hint={`${MOD_KEY}-click`}
              onClick={() => openLink(state.href!)}
            >
              <ExternalLink />
            </IconButton>
            <IconButton
              label="Edit link"
              hint={`${MOD_KEY}L`}
              onClick={() => editor.commands.openLinkEditor()}
            >
              <Pencil />
            </IconButton>
            <IconButton label="Remove link" onClick={remove}>
              <Unlink />
            </IconButton>
          </div>
        )
      )}
    </BubbleMenu>
  );
}

function LinkField({
  initial,
  canRemove,
  onApply,
  onRemove,
  onCancel,
  onLeave,
}: {
  initial: string;
  canRemove: boolean;
  onApply: (href: string) => void;
  onRemove: () => void;
  onCancel: () => void;
  onLeave: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);

  // The menu is shown before it has its final position; wait a frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <form
      ref={form}
      className="flex items-center gap-0.5"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(value);
      }}
      // Focus leaving the menu for anywhere but the editor closes it.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && form.current?.contains(next)) return;
        if (next instanceof Element && next.closest(".ProseMirror")) return;
        onLeave();
      }}
    >
      <input
        ref={input}
        aria-label="Link URL"
        className="h-7 w-60 min-w-0 rounded-md bg-input/50 px-2 text-sm outline-none placeholder:text-muted-foreground dark:bg-input/30"
        placeholder="Paste or type a link"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <IconButton label="Apply link" hint="Enter" type="submit">
        <Check />
      </IconButton>
      {canRemove && (
        <IconButton label="Remove link" onClick={onRemove}>
          <Unlink />
        </IconButton>
      )}
    </form>
  );
}

function IconButton({
  label,
  hint,
  type = "button",
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  type?: "button" | "submit";
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            type={type}
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {hint ? (
          <span className="grid gap-0.5">
            <strong className="font-medium">{label}</strong>
            <span className="text-muted-foreground">{hint}</span>
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  );
}
