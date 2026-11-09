import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Plugin, Selection, type PluginKey } from "@tiptap/pm/state";
import { exitSuggestion } from "@tiptap/suggestion";
import { useLayoutEffect, useRef, useState } from "react";
import { Copy, Scissors } from "lucide-react";
import { surfaceClass } from "./ui/surface";
import { InsertMenu, filterItems, type InsertMenuHandle, type InsertCommandOptions } from "./insert-menu";

type ContextMenuProps = {
  editor: Editor;
  options: InsertCommandOptions;
  x: number;
  y: number;
  close: () => void;
};

function EditorContextMenu({ editor, options, x, y, close }: ContextMenuProps) {
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<InsertMenuHandle>(null);
  const items = filterItems(query, editor);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = root.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const viewport = element.ownerDocument.documentElement;
      element.style.left = `${Math.max(0, Math.min(x, viewport.clientWidth - bounds.width))}px`;
      element.style.top = `${Math.max(0, Math.min(y, viewport.clientHeight - bounds.height))}px`;
      input.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [x, y]);

  const dismiss = () => {
    close();
    editor.view.focus();
  };
  const clipboard = (command: "cut" | "copy") => {
    dismiss();
    // Use the native clipboard event so ProseMirror keeps rich text and images.
    editor.view.dom.ownerDocument.execCommand(command);
  };
  return (
    <div ref={root} data-editor-context-menu="" className={`${surfaceClass} fixed z-50 flex w-56 flex-col py-1`}
      style={{ left: x, top: y, maxHeight: "100vh", overflowY: "auto" }}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
        } else if (!event.nativeEvent.isComposing && menu.current?.onKeyDown({ event: event.nativeEvent })) {
          event.preventDefault();
        }
        event.stopPropagation();
      }}>
      <div className="mx-2 mb-1 flex shrink-0 items-center gap-0.5">
        <input ref={input} role="combobox" aria-autocomplete="list" aria-expanded={items.length > 0} aria-label="Filter insert commands" placeholder="Search actions…"
          className="min-w-0 flex-1 px-1 py-1 text-sm outline-none"
          value={query} onChange={event => setQuery(event.target.value)} />
        {([["cut", "Cut", Scissors], ["copy", "Copy", Copy]] as const).map(([command, label, Icon]) =>
          <button key={command} type="button" aria-label={label} title={label}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            disabled={editor.state.selection.empty}
            onMouseDown={event => event.preventDefault()}
            onClick={() => clipboard(command)}><Icon className="size-3.5" /></button>)}
      </div>
      <InsertMenu embedded focusTarget={input} ref={menu} editor={editor} items={items} command={item => {
        if (!editor.isEditable) { dismiss(); return; }
        // The selection may be a retained text range. Insert at its caret without
        // deleting selected content; slash commands delete only their trigger.
        const position = editor.state.selection.head;
        close();
        editor.commands.setTextSelection(position);
        item.run(editor, { from: position, to: position }, options);
      }} />
      {!items.length && <p className="px-3 py-2 text-sm text-muted-foreground">No matching commands</p>}
    </div>
  );
}

export function editorContextMenu(editor: Editor, options: InsertCommandOptions, suggestionKey: PluginKey) {
  let renderer: ReactRenderer | null = null;
  let cleanup: (() => void) | null = null;
  const close = () => {
    cleanup?.();
    cleanup = null;
    renderer?.element.remove();
    renderer?.destroy();
    renderer = null;
  };
  const enabled = () => editor.isEditable && !editor.view.dom.hasAttribute("data-native-editor");
  return new Plugin({
    props: {
      handleDOMEvents: {
        // WebKit can collapse the selection on secondary mousedown, before the
        // contextmenu event. Position the selection ourselves in that event.
        mousedown: (_view, event) => {
          if (event.button !== 2 || !enabled()) return false;
          event.preventDefault();
          return true;
        },
        contextmenu: (view, event) => {
          if (!enabled()) return false;
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!hit) return false;
          event.preventDefault();
          close();
          const selection = view.state.selection;
          if (selection.empty || !selection.ranges.some(range => hit.pos >= range.$from.pos && hit.pos <= range.$to.pos)) {
            view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(hit.pos))));
          }
          exitSuggestion(view, suggestionKey);
          renderer = new ReactRenderer(EditorContextMenu, {
            editor, props: { editor, options, x: event.clientX, y: event.clientY, close },
          });
          const element = renderer.element;
          const document = view.dom.ownerDocument;
          document.body.appendChild(element);
          element.querySelector("input")?.focus({ preventScroll: true });
          const outside = (event: Event) => {
            if (event.target instanceof Node && !element.contains(event.target)) close();
          };
          const scroll = (event: Event) => {
            if (event.target instanceof Node && element.contains(event.target)) return;
            close();
          };
          document.addEventListener("pointerdown", outside, true);
          document.addEventListener("focusin", outside);
          document.addEventListener("scroll", scroll, true);
          document.defaultView?.addEventListener("resize", close);
          cleanup = () => {
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("focusin", outside);
            document.removeEventListener("scroll", scroll, true);
            document.defaultView?.removeEventListener("resize", close);
          };
          return true;
        },
      },
    },
    view: () => ({
      update: (view, previous) => {
        if (!editor.isEditable || !previous.doc.eq(view.state.doc) || !previous.selection.eq(view.state.selection)) close();
      },
      destroy: close,
    }),
  });
}
