import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Popover } from "@base-ui/react/popover";
import { FileText, ArrowUpRight } from "lucide-react";
import { createContext, useContext, useCallback, useEffect, useMemo, useState, useRef, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection, PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { createStore } from "@tanstack/react-store";
import { getFoldedRanges, getFoldedIds } from "@/lib/heading-fold";
import { stopScrollRestore } from "@/lib/view-persistence";
import { Mention, mentionPage, mentionTarget, type MentionTarget } from "@/lib/mention";
import { useMentionNotes } from "@/lib/use-mentions";
import { useDocuments } from "@/lib/use-documents";
import { backlinks, mentionLabel, type MentionBankItem } from "@/lib/mention-index";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { bankIndexQuery, questionLabel, useBankGate, type BankIndex } from "@/lib/question-bank";
import { setModulePage } from "@/lib/store";
import type { DocumentRecord } from "@/lib/documents";
import { requestSyncedFile } from "@/lib/sync/file-requests";
import { InsertMenu, type InsertMenuHandle, type InsertItem } from "./insert-menu";

type Target = NonNullable<ReturnType<typeof mentionTarget>>;
const EMPTY_FILES: DocumentRecord[] = [];
const MAX_MENTION_RESULTS = 100;
const Context = createContext<Omit<ReturnType<typeof useMentionNotes>, "modules"> & { files: DocumentRecord[]; bankItems: MentionBankItem[] } | null>(null);
export function MentionProvider({ children }: { children: ReactNode }) {
  const { modules, ...notes } = useMentionNotes();
  const { data: files = EMPTY_FILES } = useDocuments();
  const bankEnabled = useBankGate();
  const queries = useMemo(() => modules.map(module => bankIndexQuery(module.id, bankEnabled)), [modules, bankEnabled]);
  const combine = useCallback((results: UseQueryResult<BankIndex | null>[]) => ({
    items: results.flatMap(({ data: bank }, index): MentionBankItem[] => {
      const moduleId = modules[index].id;
      const questions = [...(bank?.questions ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      return [
        ...questions.map(({ id, title }, number) => ({ kind: "question" as const, moduleId, id, title: questionLabel(title, number + 1) })),
        ...(bank?.worksheets ?? []).map(({ id, title }) => ({ kind: "worksheet" as const, moduleId, id, title: title || "Worksheet" })),
      ];
    }),
    loading: bankEnabled && results.some(result => result.isPending),
  }), [modules, bankEnabled]);
  const banks = useQueries({ queries, combine });
  return <Context.Provider value={{ ...notes, files, bankItems: banks.items, loading: notes.loading || banks.loading }}>{children}</Context.Provider>;
}
function useCatalog() {
  const value = useContext(Context);
  if (!value) throw new Error("MentionProvider missing");
  return value;
}
// The module open in the editor, so @ lists it first.
let editingModule = "";
const jump = createStore<{ moduleId: string; kind: "heading" | "image" | "mention"; id: string } | null>(null);
function useOpenReference() {
  const navigate = useNavigate();
  return (target: Target) => {
    if (target.kind === "file" || target.kind === "pdf-page") {
      const page = target.kind === "pdf-page" ? mentionPage(target.locator) : undefined;
      void navigate({ to: "/files/$documentId", params: { documentId: target.id }, search: page ? { page } : {} });
      return;
    }
    if (target.kind === "question" || target.kind === "worksheet") {
      if (target.nodeId) void navigate({ to: "/questions", search: { module: target.id, [target.kind]: target.nodeId } });
      return;
    }
    if (target.kind !== "module" && target.kind !== "heading" && target.kind !== "image") return;
    const kind = target.kind === "image" ? "image" : "heading";
    if (kind === "image") setModulePage(target.id, "notes");
    jump.setState(() => target.nodeId ? { moduleId: target.id, kind, id: target.nodeId } : null);
    void navigate({ to: "/$moduleId", params: { moduleId: target.id } });
  };
}
export function MentionNavigation({ editor, moduleId, ready }: { editor: Editor | null; moduleId: string; ready: boolean }) {
  const request = useSelector(jump, state => state);
  useEffect(() => { editingModule = moduleId; }, [moduleId]);
  useEffect(() => {
    if (!editor || !ready || request?.moduleId !== moduleId) return;
    let position: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      const id = request.kind === "heading" && node.type.name === "heading" ? node.attrs["data-toc-id"]
        : request.kind === "image" && (node.type.name === "image" || node.type.name === "inlineImage") ? node.attrs.imageId
        : request.kind === "mention" && node.type.name === "mention" ? node.attrs.mentionId : null;
      if (id === request.id) position = pos;
    });
    if (position !== null) {
      // A pending restore of this note's saved scroll would pull the view
      // back off the reference destination once layout settles.
      stopScrollRestore();
      editor.commands.showDocument();
      const destination = position;
      const hiddenBy = new Set(getFoldedRanges(editor.state).filter(range => destination >= range.from && destination < range.to).map(range => range.id));
      if (hiddenBy.size) editor.commands.setFolds(getFoldedIds(editor.state).filter(id => !hiddenBy.has(id)));
      if (request.kind === "image") {
        const { state, view } = editor;
        view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, destination)));
        view.dom.focus({ preventScroll: true });
        const image = view.nodeDOM(destination);
        if (image instanceof HTMLElement) image.scrollIntoView({ block: "center", inline: "nearest" });
      } else {
        editor.commands.setTextSelection(position + (request.kind === "heading" ? 1 : 0));
        editor.commands.focus();
        editor.commands.scrollIntoView();
      }
    }
    jump.setState(() => null);
  }, [editor, ready, moduleId, request]);
  return null;
}
function MentionChip({ node }: NodeViewProps) {
  const catalog = useCatalog();
  const open = useOpenReference();
  const target = mentionTarget(node.attrs.target);
  const label = target ? mentionLabel(catalog.notes, catalog.files, target, catalog.bankItems) : undefined;
  return <NodeViewWrapper as="span" className="mention-chip" contentEditable={false}><button type="button" onMouseDown={event => event.preventDefault()} onClick={() => target && label && open(target)} title={label ?? "Reference unavailable"}>@{label ?? (catalog.loading ? "Loading…" : "Reference unavailable")}</button></NodeViewWrapper>;
}
export const MentionView = Mention.extend({ addNodeView: () => ReactNodeViewRenderer(MentionChip) });

const MentionMenu = forwardRef<InsertMenuHandle, SuggestionProps<InsertItem, InsertItem>>((props, ref) => {
  const catalog = useCatalog();
  const menu = useRef<InsertMenuHandle>(null);
  // Where Tab has dug to: a module id, then one section id per level below it.
  const [trail, setTrail] = useState<string[]>([]);
  const [pdfScope, setPdfScope] = useState<{ id: string; query: string } | null>(null);
  const pdf = catalog.files.find(file => file.id === pdfScope?.id);
  const pdfCount = useQuery({
    queryKey: ["mention-pdf-pages", pdf?.id],
    enabled: !!pdf?.available && pdf.pageCount == null,
    queryFn: async ({ signal }) => {
      if (!pdf) throw new Error("PDF unavailable");
      const { loadPdf } = await import("@/lib/pdf-loading");
      const task = await loadPdf(pdf.id, signal);
      const cancel = () => { void task.destroy(); };
      signal.addEventListener("abort", cancel, { once: true });
      try { return (await task.promise).numPages; }
      finally {
        signal.removeEventListener("abort", cancel);
        if (!signal.aborted) await task.destroy();
      }
    },
    staleTime: Infinity,
    retry: false,
  });
  const pageCount = pdf?.pageCount ?? pdfCount.data ?? 0;
  const model = useMemo(() => {
    // The module being edited comes first; the rest keep their order.
    const notes = [...catalog.notes].sort((a, b) => Number(b.id === editingModule) - Number(a.id === editingModule));
    const terms = props.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const query = terms.join(" ");
    const searching = terms.length > 0;
    const matches = (path: string[]) => { const text = path.join(" / ").toLocaleLowerCase(); return terms.every(term => text.includes(term)); };
    const scope = trail[0];
    const parent = trail.length > 1 ? trail[trail.length - 1] : null;
    const enter = new Map<string, string[]>();
    const candidates: { id: string; title: string; group: string; detail?: string; expandable?: boolean; target?: MentionTarget }[] = [];
    let header = "";
    if (pdf && pdfScope) {
      header = pdf.name;
      const pageQuery = props.query.startsWith(pdfScope.query) ? props.query.slice(pdfScope.query.length) : props.query;
      const prefix = pageQuery.trim().toLocaleLowerCase().replace(/^p(?:age)?[. ]*/, "");
      for (let page = 1; page <= pageCount && candidates.length < MAX_MENTION_RESULTS; page++) {
        const locator = String(page);
        if (locator.startsWith(prefix)) candidates.push({
          id: `page:${locator}`, title: `Page ${locator}`, group: "",
          target: { kind: "pdf-page", id: pdf.id, nodeId: null, locator },
        });
      }
    } else for (const note of notes) {
      if (scope && note.id !== scope) continue;
      if (!scope && matches([note.name])) {
        const expandable = note.note.headings.length > 0;
        candidates.push({ id: `module:${note.id}`, title: note.name, group: "", expandable, target: { kind: "module", id: note.id, nodeId: null, locator: null } });
        if (expandable) enter.set(`module:${note.id}`, [note.id]);
      }
      if (!scope && !searching) continue;
      const byId = new Map(note.note.headings.map(heading => [heading.id, heading]));
      const parents = new Set(note.note.headings.map(heading => heading.parentId));
      // Section ids from the module's top down to (and including) a section.
      const chain = (id: string) => { const ids: string[] = []; for (let at = byId.get(id); at && ids.length < 50; at = at.parentId ? byId.get(at.parentId) : undefined) ids.unshift(at.id); return ids; };
      if (scope) header = [note.name, ...trail.slice(1).map(id => byId.get(id)?.title ?? "")].join(" / ");
      for (const heading of note.note.headings) {
        const path = [note.name, ...(heading.path ?? [])];
        if (searching ? !matches([...path, heading.title]) : parent ? heading.parentId !== parent : (heading.path ?? []).length > 0) continue;
        if (searching && parent && !chain(heading.id).slice(0, -1).includes(parent)) continue;
        const id = `heading:${note.id}:${heading.id}`;
        const expandable = parents.has(heading.id);
        candidates.push({ id, title: heading.title, group: "", expandable, ...(searching ? { detail: path.join(" / ") } : {}), target: { kind: "heading", id: note.id, nodeId: heading.id, locator: null } });
        if (expandable) enter.set(id, [note.id, ...chain(heading.id)]);
      }
    }
    if (!scope && !pdfScope) {
      const files = catalog.files.filter(file => matches([file.name]));
      for (const file of files) candidates.push({ id: `file:${file.id}`, title: file.name, group: "Files", target: { kind: "file", id: file.id, nodeId: null, locator: null } });
      for (const note of notes) for (const image of note.note.images) {
        if (matches([note.name, image.title, "image"])) candidates.push({
          id: `image:${note.id}:${image.id}`, title: image.title, detail: note.name, group: "Images",
          target: { kind: "image", id: note.id, nodeId: image.id, locator: null },
        });
      }
      for (const file of catalog.files) if (matches([file.name, "pdf pages"])) candidates.push({
        id: `pdf:${file.id}`, title: `${file.name} pages`, group: "PDF pages", expandable: true,
      });
      const noteNames = new Map(notes.map(note => [note.id, note.name]));
      for (const kind of ["question", "worksheet"] as const) for (const item of catalog.bankItems) {
        if (item.kind !== kind) continue;
        const moduleName = noteNames.get(item.moduleId) ?? "";
        if (matches([moduleName, item.title, kind])) candidates.push({
          id: `${kind}:${item.moduleId}:${item.id}`, title: item.title, detail: moduleName,
          group: kind === "question" ? "Questions" : "Worksheets",
          target: { kind, id: item.moduleId, nodeId: item.id, locator: null },
        });
      }
    }
    const rank = (title: string) => {
      const text = title.toLocaleLowerCase().trim().replace(/\s+/g, " ");
      return text === query ? 0 : text.startsWith(query) ? 1 : 2;
    };
    const ranked = searching && !pdfScope
      ? candidates.map(candidate => ({ candidate, rank: rank(candidate.title) }))
        .sort((a, b) => a.rank - b.rank).map(({ candidate }) => candidate)
      : candidates;
    const kindOf = (candidate: typeof candidates[number]) => candidate.target?.kind ?? "pdf";
    const counts = new Map<string, number>();
    const kindCount = new Set(ranked.map(kindOf)).size;
    const share = Math.floor(MAX_MENTION_RESULTS / Math.max(1, kindCount));
    const selected = new Set(ranked.filter(candidate => {
      const kind = kindOf(candidate);
      const count = counts.get(kind) ?? 0;
      if (count >= share) return false;
      counts.set(kind, count + 1);
      return true;
    }));
    for (const candidate of ranked) {
      if (selected.size >= MAX_MENTION_RESULTS) break;
      selected.add(candidate);
    }
    // Keep each group together, ordered by its highest-ranked selected item.
    const groups = new Map<string, typeof candidates>();
    for (const candidate of ranked) if (selected.has(candidate)) {
      const rows = groups.get(candidate.group) ?? [];
      rows.push(candidate);
      groups.set(candidate.group, rows);
    }
    const items = [...groups.values()].flat().map(({ target, ...item }): InsertItem => ({
      ...item, hint: "", keywords: [],
      run: (editor, range) => { if (target) editor.chain().focus().insertContentAt(range, [{ type: "mention", attrs: { target, mentionId: crypto.randomUUID() } }, { type: "text", text: " " }]).run(); },
    }));
    return { items, enter, header };
  }, [catalog.notes, catalog.files, catalog.bankItems, pageCount, pdf, pdfScope, props.query, trail]);
  const browsePdf = (item: InsertItem | undefined) => {
    if (!item?.id?.startsWith("pdf:")) return false;
    const file = catalog.files.find(file => file.id === item.id?.slice(4));
    if (!file) return false;
    if (file.pageCount == null && !file.available) requestSyncedFile(file.id);
    setPdfScope({ id: file.id, query: props.query });
    return true;
  };
  // Tab digs into the highlighted row, Shift+Tab (or Backspace on an empty query) climbs out.
  // The document is never touched, and browser focus never moves.
  const onKey = (event: KeyboardEvent, item: InsertItem | undefined) => {
    if (pdfScope && ((event.key === "Tab" && event.shiftKey) || (event.key === "Backspace" && props.query === pdfScope.query))) {
      setPdfScope(null);
      return true;
    }
    if (event.key === "Tab") {
      if (!event.shiftKey && browsePdf(item)) return true;
      const next = item?.id ? model.enter.get(item.id) : undefined;
      if (next && !event.shiftKey) setTrail(next);
      else if (event.shiftKey) setTrail(current => current.slice(0, -1));
      return true;
    }
    if (event.key === "Backspace" && !props.query && trail.length) { setTrail(current => current.slice(0, -1)); return true; }
    return false;
  };
  useImperativeHandle(ref, () => ({ onKeyDown: args => menu.current ? menu.current.onKeyDown(args) : onKey(args.event, undefined) }));
  if (!model.items.length && (pdf ? pdfCount.isFetching : catalog.loading)) return null;
  if (!model.items.length) return <div role="status" className="rounded-lg bg-popover p-3 text-sm text-muted-foreground shadow-md">
    {pdf && !pageCount
      ? pdfCount.isError ? "Could not read PDF pages" : pdf.available ? "No matches" : "Downloading PDF…"
      : catalog.error ? "Could not load references" : "No matches"}
  </div>;
  return <InsertMenu ref={menu} editor={props.editor} items={model.items} header={model.header} onKey={onKey} wide command={item => { if (!browsePdf(item)) props.command(item); }} />;
});
export const MentionSuggest = Extension.create({
  name: "mention-suggest", priority: 201,
  addProseMirrorPlugins() {
    return [Suggestion<InsertItem, InsertItem>({ editor: this.editor, pluginKey: new PluginKey("mention-suggest"), char: "@", allowSpaces: true,
      // MentionMenu filters the warm catalog. Skip Suggestion’s async items lifecycle.
      minQueryLength: Infinity,
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
export function MentionedIn({ target, onOpenChange }: { target: Target; onOpenChange?: (open: boolean) => void }) {
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
  const fullLabel = mentionLabel(catalog.notes, catalog.files, target, catalog.bankItems);
  const label = `${sources.length} incoming ${sources.length === 1 ? "reference" : "references"}${title ? ` to ${title}` : ""}`;

  if (!sources.length && !open) return null;
  return <Popover.Root open={open} onOpenChange={next => {
    if (next) navigating.current = false;
    setOpen(next);
    onOpenChange?.(next);
  }}>
    <IconTooltip label={label} hint={target.kind === "heading" ? "Alt+F10" : undefined}><Popover.Trigger
      data-backlink-trigger=""
      aria-label={label}
      aria-keyshortcuts={target.kind === "heading" ? "Alt+F10" : undefined}
      className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >{sources.length > 99 ? "99+" : sources.length}</Popover.Trigger></IconTooltip>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-50">
        <Popover.Popup
          data-backlink-popover=""
          finalFocus={() => !navigating.current}
          className="floating-surface max-h-[min(24rem,60vh)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg bg-popover p-1.5 text-popover-foreground shadow-md outline-none"
        >
          <Popover.Title className="truncate px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Linked to {fullLabel ?? "this reference"}</Popover.Title>
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
