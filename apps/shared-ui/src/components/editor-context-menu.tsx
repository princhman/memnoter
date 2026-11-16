import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Plugin, Selection, type EditorState, type PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { exitSuggestion } from "@tiptap/suggestion";
import { useLayoutEffect, useRef, useState } from "react";
import { BookPlus, Copy, Scissors } from "lucide-react";
import { toast } from "sonner";
import { call, capabilities } from "../lib/backend.ts";
import { surfaceClass } from "./ui/surface";
import { InsertMenu, filterItems, groupCardActions, type InsertMenuHandle, type InsertCommandOptions } from "./insert-menu";

type Misspelling = { word: string; from: number; to: number; suggestions: string[] };

type ContextMenuProps = {
  editor: Editor;
  options: InsertCommandOptions;
  misspelling: Misspelling | null;
  x: number;
  y: number;
  close: () => void;
};

const WORD_CHARACTER = /[\p{L}\p{M}'’]/u;

// The word under the pointer, if it is ordinary prose the webview spell checks.
function wordAt(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code || $pos.marks().some(mark => mark.type.spec.code)) return null;
  const text = parent.textBetween(0, parent.content.size, undefined, "\ufffc");
  let start = $pos.parentOffset;
  let end = start;
  while (start > 0 && WORD_CHARACTER.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHARACTER.test(text[end])) end++;
  while (start < end && /['’]/.test(text[start])) start++;
  while (end > start && /['’]/.test(text[end - 1])) end--;
  const word = text.slice(start, end);
  const from = $pos.start() + start;
  const to = $pos.start() + end;
  // Nodes inside the paragraph can shift offsets; skip rather than misplace.
  if (!/\p{L}/u.test(word) || state.doc.textBetween(from, to) !== word) return null;
  return { word, from, to };
}

async function findMisspelling(state: EditorState, pos: number): Promise<Misspelling | null> {
  const word = wordAt(state, pos);
  if (!word) return null;
  try {
    const result = await call<{ suggestions: string[] } | null>("check_spelling", { word: word.word });
    return result && { ...word, suggestions: result.suggestions };
  } catch (error) {
    console.error("Unable to check spelling:", error);
    return null;
  }
}

// The webview caches its underlines; turning spell checking off and on again
// makes it check the text again, now with the word in the dictionary.
function recheckSpelling(dom: HTMLElement) {
  const previous = dom.getAttribute("spellcheck");
  dom.spellcheck = false;
  requestAnimationFrame(() => {
    if (previous === null) dom.removeAttribute("spellcheck");
    else dom.setAttribute("spellcheck", previous);
  });
}

function SpellingSection({ editor, misspelling, dismiss }: { editor: Editor; misspelling: Misspelling; dismiss: () => void }) {
  const itemClass = "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground";
  const replace = (suggestion: string) => {
    dismiss();
    const { state } = editor.view;
    // Only replace the word if it is still where the menu found it.
    if (!editor.isEditable || state.doc.textBetween(misspelling.from, misspelling.to) !== misspelling.word) return;
    editor.view.dispatch(state.tr.insertText(suggestion, misspelling.from, misspelling.to));
  };
  const add = () => {
    dismiss();
    call("add_to_dictionary", { word: misspelling.word })
      .then(() => recheckSpelling(editor.view.dom))
      .catch(error => toast.error(`Couldn't add “${misspelling.word}” to the dictionary: ${error instanceof Error ? error.message : String(error)}`));
  };
  return (
    <div className="mx-1 mb-1 flex shrink-0 flex-col border-b pb-1">
      {misspelling.suggestions.map(suggestion =>
        <button key={suggestion} type="button" className={`${itemClass} font-medium`}
          onMouseDown={event => event.preventDefault()} onClick={() => replace(suggestion)}>
          <span className="truncate">{suggestion}</span>
        </button>)}
      {!misspelling.suggestions.length && <p className="px-2 py-1 text-sm text-muted-foreground">No spelling suggestions</p>}
      <button type="button" className={itemClass} onMouseDown={event => event.preventDefault()} onClick={add}>
        <BookPlus className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">Add to dictionary</span>
      </button>
    </div>
  );
}

function EditorContextMenu({ editor, options, misspelling, x, y, close }: ContextMenuProps) {
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<InsertMenuHandle>(null);
  const items = [...(options.flashcards === false ? [] : groupCardActions).filter(item => item.when?.(editor) && item.title.toLowerCase().includes(query.toLowerCase())), ...filterItems(query, editor, options)];
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
        } else if (event.target === input.current && !event.nativeEvent.isComposing && menu.current?.onKeyDown({ event: event.nativeEvent })) {
          // Only the search field drives the command list; buttons keep their own keys.
          event.preventDefault();
        }
        event.stopPropagation();
      }}>
      {misspelling && <SpellingSection editor={editor} misspelling={misspelling} dismiss={dismiss} />}
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
        if (!item.retainSelection) editor.commands.setTextSelection(position);
        item.run(editor, { from: position, to: position }, options);
      }} />
      {!items.length && <p className="px-3 py-2 text-sm text-muted-foreground">No matching commands</p>}
    </div>
  );
}

export function editorContextMenu(editor: Editor, options: InsertCommandOptions, suggestionKey: PluginKey) {
  let renderer: ReactRenderer | null = null;
  let cleanup: (() => void) | null = null;
  let opening = 0;
  const close = () => {
    opening++;
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
          if (!capabilities.spelling) {
            open(view, event, null);
            return true;
          }
          const request = opening;
          const state = view.state;
          void findMisspelling(state, hit.pos).then(misspelling => {
            // A newer menu, an edit, or a selection change cancelled this one.
            if (request === opening && view.state === state) open(view, event, misspelling);
          });
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

  function open(view: EditorView, event: MouseEvent, misspelling: Misspelling | null) {
    renderer = new ReactRenderer(EditorContextMenu, {
      editor, props: { editor, options, misspelling, x: event.clientX, y: event.clientY, close },
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
  }
}
