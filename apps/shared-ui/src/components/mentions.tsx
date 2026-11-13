import { createContext, useContext, useEffect, useMemo, useState, forwardRef, type ReactNode } from "react";
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
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const Context = createContext<ReturnType<typeof useMentionNotes> & { files: { id: string; name: string }[]; showBacklinks: (target: MentionTarget) => void } | null>(null);
export function MentionProvider({ children }: { children: ReactNode }) {
  const notes = useMentionNotes();
  const { data: files = [] } = useDocuments();
  const [target, setTarget] = useState<MentionTarget | null>(null);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  return <Context.Provider value={{ ...notes, files, showBacklinks: target => { setTarget(target); setBacklinksOpen(true); } }}>{children}<BacklinkDialog target={target} open={backlinksOpen} close={() => setBacklinksOpen(false)} /></Context.Provider>;
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
export function MentionedIn({ target }: { target: MentionTarget }) {
  const { notes, showBacklinks } = useCatalog();
  const sources = backlinks(notes, target);
  if (!sources.length) return null;
  return <button type="button" className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => showBacklinks(target)}>Mentioned in {sources.length}</button>;
}
function BacklinkDialog({ target, open, close }: { target: MentionTarget | null; open: boolean; close: () => void }) {
  const { notes, loading, error } = useCatalog();
  const navigate = useNavigate();
  const sources = target ? backlinks(notes, target) : [];
  return <Dialog open={open} onOpenChange={open => { if (!open) close(); }}><DialogContent finalFocus={false}><DialogTitle>Mentioned in {sources.length}</DialogTitle>
    {sources.map((source, index) => <button key={`${source.moduleId}:${source.mentionId}:${index}`} className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => {
      close(); jump.setState(() => ({ moduleId: source.moduleId, kind: "mention", id: source.mentionId })); void navigate({ to: "/$moduleId", params: { moduleId: source.moduleId } });
    }}>{source.moduleName}{source.heading ? ` › ${source.heading}` : ""}</button>)}
    {!sources.length && <p className="text-sm text-muted-foreground">{error ? "Could not load references" : loading ? "Loading…" : "No mentions"}</p>}
  </DialogContent></Dialog>;
}
