import { Popover } from "@base-ui/react/popover";
import { FileText, ArrowUpRight } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, useRef, forwardRef, type ReactNode } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { createStore } from "@tanstack/react-store";
import { getFoldedRanges, getFoldedIds } from "@/lib/heading-fold";
import { Mention, mentionTarget, type MentionTarget } from "@/lib/mention";
import { useMentionNotes } from "@/lib/use-mentions";
import { useDocuments } from "@/lib/use-documents";
import { backlinks } from "@/lib/mention-index";
import { InsertMenu, type InsertMenuHandle, type InsertItem } from "./insert-menu";

const Context = createContext<ReturnType<typeof useMentionNotes> & { files: { id: string; name: string }[] } | null>(null);
export function MentionProvider({ children }: { children: ReactNode }) {
  const notes = useMentionNotes();
  const { data: files = [] } = useDocuments();
  return <Context.Provider value={{ ...notes, files }}>{children}</Context.Provider>;
}
function useCatalog() {
  const value = useContext(Context);
  if (!value) throw new Error("MentionProvider missing");
  return value;
}
const jump = createStore<{ moduleId: string; kind: "heading" | "mention"; id: string } | null>(null);
function useOpenReference() {
  const navigate = useNavigate();
  return (target: MentionTarget) => {
    if (target.kind === "file") { void navigate({ to: "/files/$documentId", params: { documentId: target.id } }); return; }
    if (target.kind !== "module" && target.kind !== "heading") return;
    jump.setState(() => target.nodeId ? { moduleId: target.id, kind: "heading", id: target.nodeId } : null);
    void navigate({ to: "/$moduleId", params: { moduleId: target.id } });
  };
}
export function MentionNavigation({ editor, moduleId, ready }: { editor: Editor | null; moduleId: string; ready: boolean }) {
  const request = useSelector(jump, state => state);
  useEffect(() => {
    if (!editor || !ready || request?.moduleId !== moduleId) return;
    let position: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (request.kind === "heading" ? node.type.name === "heading" && node.attrs["data-toc-id"] === request.id : node.type.name === "mention" && node.attrs.mentionId === request.id) position = pos;
    });
    if (position !== null) {
      editor.commands.showDocument();
      const destination = position;
      const hiddenBy = new Set(getFoldedRanges(editor.state).filter(range => destination >= range.from && destination < range.to).map(range => range.id));
      if (hiddenBy.size) editor.commands.setFolds(getFoldedIds(editor.state).filter(id => !hiddenBy.has(id)));
      editor.commands.setTextSelection(position + (request.kind === "heading" ? 1 : 0));
      editor.commands.focus();
      editor.commands.scrollIntoView();
    }
    jump.setState(() => null);
  }, [editor, ready, moduleId, request]);
  return null;
}
function MentionChip({ node }: NodeViewProps) {
  const catalog = useCatalog();
  const open = useOpenReference();
  const target = mentionTarget(node.attrs.target);
  const module = catalog.notes.find(note => note.id === target?.id);
  const title = target?.kind === "file" ? catalog.files.find(file => file.id === target.id)?.name : target?.kind === "heading" ? module?.note.headings.find(heading => heading.id === target.nodeId)?.title : module?.name;
  const label = target?.kind === "heading" && title ? `${module?.name} › ${title}` : title;
  return <NodeViewWrapper as="span" className="mention-chip" contentEditable={false}><button type="button" onMouseDown={event => event.preventDefault()} onClick={() => target && open(target)} title={label ?? "Reference unavailable"}>@{label ?? (catalog.loading ? "Loading…" : "Reference unavailable")}</button></NodeViewWrapper>;
}
export const MentionView = Mention.extend({ addNodeView: () => ReactNodeViewRenderer(MentionChip) });

const MentionMenu = forwardRef<InsertMenuHandle, SuggestionProps<InsertItem, InsertItem>>((props, ref) => {
  const catalog = useCatalog();
  const items = useMemo(() => {
    const candidates: { title: string; group: string; target: MentionTarget }[] = [];
    for (const note of catalog.notes) {
      candidates.push({ title: note.name, group: "Modules", target: { kind: "module", id: note.id, nodeId: null, locator: null } });
    }
    for (const note of catalog.notes) for (const heading of note.note.headings) candidates.push({ title: `${note.name} › ${heading.title}`, group: "Headings", target: { kind: "heading", id: note.id, nodeId: heading.id, locator: null } });
    for (const file of catalog.files) candidates.push({ title: file.name, group: "Files", target: { kind: "file", id: file.id, nodeId: null, locator: null } });
    const terms = props.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return candidates.filter(item => terms.every(term => item.title.toLocaleLowerCase().includes(term))).slice(0, 100).map((item): InsertItem => ({
      ...item, hint: "", keywords: [],
      run: (editor, range) => { editor.chain().focus().insertContentAt(range, [{ type: "mention", attrs: { target: item.target, mentionId: crypto.randomUUID() } }, { type: "text", text: " " }]).run(); },
    }));
  }, [catalog.notes, catalog.files, props.query]);
  if (!items.length) return <div role="status" className="rounded-lg bg-popover p-3 text-sm text-muted-foreground shadow-md">{catalog.error ? "Could not load references" : catalog.loading ? "Loading…" : "No matches"}</div>;
  return <InsertMenu ref={ref} editor={props.editor} items={items} command={item => props.command(item)} />;
});
export const MentionSuggest = Extension.create({
  name: "mention-suggest", priority: 201,
  addProseMirrorPlugins() {
    return [Suggestion<InsertItem, InsertItem>({ editor: this.editor, pluginKey: new PluginKey("mention-suggest"), char: "@", allowSpaces: true,
      allow: ({ state, range }) => {
        const resolved = state.doc.resolve(range.from);
        for (let depth = resolved.depth; depth > 0; depth--) if (["codeBlock", "mathBlock", "inlineMath"].includes(resolved.node(depth).type.name)) return false;
        return true;
      },
      command: ({ editor, range, props }) => props.run(editor, range, { insertImages: () => {} }),
      render: () => {
        let renderer: ReactRenderer<InsertMenuHandle, SuggestionProps<InsertItem, InsertItem>> | null = null;
        let unmount: (() => void) | null = null;
        return {
          onStart: props => { renderer = new ReactRenderer(MentionMenu, { props, editor: props.editor, className: "z-50" }); unmount = props.mount?.(renderer.element) ?? null; },
          onUpdate: props => renderer?.updateProps(props),
          onKeyDown: props => renderer?.ref?.onKeyDown(props) ?? false,
          onExit: () => { unmount?.(); renderer?.destroy(); renderer = null; unmount = null; },
        };
      },
    })];
  },
});
export function MentionedIn({ target, onOpenChange }: { target: MentionTarget; onOpenChange?: (open: boolean) => void }) {
  const catalog = useCatalog();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  const sources = backlinks(catalog.notes, target);
  const module = catalog.notes.find(note => note.id === target.id);
  const title = target.kind === "file"
    ? catalog.files.find(file => file.id === target.id)?.name
    : target.kind === "heading"
      ? module?.note.headings.find(heading => heading.id === target.nodeId)?.title
      : module?.name;
  const label = `${sources.length} incoming ${sources.length === 1 ? "reference" : "references"}${title ? ` to ${title}` : ""}`;

  if (!sources.length && !open) return null;
  return <Popover.Root open={open} onOpenChange={next => {
    if (next) navigating.current = false;
    setOpen(next);
    onOpenChange?.(next);
  }}>
    <Popover.Trigger
      data-backlink-trigger=""
      aria-label={label}
      title={`${label}${target.kind === "heading" ? " (Alt+F10 from heading)" : ""}`}
      aria-keyshortcuts={target.kind === "heading" ? "Alt+F10" : undefined}
      className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >{sources.length > 99 ? "99+" : sources.length}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-50">
        <Popover.Popup
          data-backlink-popover=""
          finalFocus={() => !navigating.current}
          className="floating-surface max-h-[min(24rem,60vh)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg bg-popover p-1.5 text-popover-foreground shadow-md outline-none"
        >
          <Popover.Title className="truncate px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Linked to {title ?? "this reference"}</Popover.Title>
          {sources.map((source, index) => <button
            key={`${source.moduleId}:${source.mentionId}:${index}`}
            type="button"
            className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => {
              navigating.current = true;
              setOpen(false);
              onOpenChange?.(false);
              jump.setState(() => ({ moduleId: source.moduleId, kind: "mention", id: source.mentionId }));
              void navigate({ to: "/$moduleId", params: { moduleId: source.moduleId } });
            }}
          >
            <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 break-words">{source.moduleName}{source.heading && <span className="text-muted-foreground"> › {source.heading}</span>}</span>
            <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          </button>)}
          {!sources.length && <p className="px-2 py-3 text-sm text-muted-foreground">No mentions</p>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
