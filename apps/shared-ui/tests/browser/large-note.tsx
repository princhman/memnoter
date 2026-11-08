import { visibleNoteExtensions } from "../support/editor-ui";
import { Profiler } from "react";
import { TableOfContents, createTocStore } from "@/components/table-of-contents";
import { createRoot, type Root } from "react-dom/client";
import { EditorContent } from "@tiptap/react";
import { TextBubbleMenu } from "@/components/text-bubble-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Editor, type JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { noteExtensions } from "@/lib/editor-schema";
import { prepareFolderImport, type ImportFolder } from "@/lib/folder-import";
import { extractCards } from "@/lib/cards";
import { extractFromDoc } from "@/lib/search-text";
import { createSaveQueue } from "@/lib/save-queue";
import { headingNumberingKey } from "@/lib/heading-numbering";
import "@/App.css";

// No app backend or persisted module: imported assets are served by the runner.
const root = document.getElementById("root")!;
root.className = "app-scroll-container";
root.style.cssText = "height:100vh;overflow:auto;padding:32px 80px";
let activeEditor: Editor | undefined;
let activeDoc: Y.Doc | undefined;
let mount: Root | undefined;
const timings = new Map<string, number[]>();
function timed<T>(name: string, run: () => T): T {
  const start = performance.now();
  try { return run(); } finally {
    const values = timings.get(name) ?? [];
    values.push(performance.now() - start);
    timings.set(name, values);
  }
}
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
Object.assign(window, {
  prepareFolderImport,
  async openLargeNote(folder: ImportFolder) {
    mount?.unmount(); activeEditor?.destroy(); activeDoc?.destroy(); root.replaceChildren();
    const plan = await prepareFolderImport(folder);
    // Reproduce import normalization, then reopening the saved Yjs snapshot.
    const scratch = new Y.Doc();
    const normalizer = new Editor({ extensions: noteExtensions({ document: scratch }) });
    normalizer.commands.setContent(plan.document);
    await new Promise(resolve => setTimeout(resolve, 0));
    const normalized: JSONContent = normalizer.getJSON();
    const assets = (node: JSONContent) => {
      if (node.attrs?.fileId) {
        node.attrs.src = `/course-asset?path=${encodeURIComponent(node.attrs.fileId)}`;
        node.attrs.fileId = null;
      }
      node.content?.forEach(assets);
    };
    assets(normalized);
    const saved = prosemirrorJSONToYDoc(normalizer.schema, normalized, "default");
    normalizer.destroy(); scratch.destroy();
    const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(saved)); saved.destroy();
    const start = performance.now();
    const store = createTocStore();
    const tocCommits: number[] = [];
    const extensions = visibleNoteExtensions({ document: doc, onTocUpdate: items => store.setState(() => items) }).map(extension => {
      if (!extension.config.onTransaction) return extension;
      return extension.extend({
        onTransaction(event) {
          timed(`${extension.name}:onTransaction`, () => this.parent?.(event));
        },
      });
    });
    const editor = new Editor({ element: root.appendChild(document.createElement("div")), extensions });
    activeEditor = editor; activeDoc = doc;
    mount = createRoot(root);
    mount.render(<TooltipProvider><EditorContent editor={editor} /><TextBubbleMenu editor={editor} /><Profiler id="toc" onRender={() => tocCommits.push(performance.now())}><TableOfContents editor={editor} store={store} /></Profiler></TooltipProvider>);
    editor.view.dispatch(editor.state.tr.setMeta(headingNumberingKey, true));
    await paint();
    const opening = performance.now() - start;
    // Instrument real plugin callbacks, preserving their receiver and arguments.
    for (const plugin of editor.state.plugins) {
      const wrap = (object: Record<string, unknown>, key: string, label: string) => {
        const original = object[key];
        if (typeof original === "function") object[key] = function (...args: unknown[]) {
          return timed(`${plugin.key}:${label}`, () => original.apply(this, args));
        };
      };
      if (plugin.spec.state) wrap(plugin.spec.state as unknown as Record<string, unknown>, "apply", "apply");
      wrap(plugin.spec as unknown as Record<string, unknown>, "appendTransaction", "append");
      wrap(plugin.props as unknown as Record<string, unknown>, "decorations", "decorations");
    }
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.state.plugins }));
    let nodes = 0; editor.state.doc.descendants(() => { nodes++; });
    const stats = { nodes, characters: editor.state.doc.textContent.length, opening };
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph" && node.textContent.length > 20) positions.push(pos + 5); });
    Object.assign(window, { editor, timings, doc, paint, stats, positions, tocCommits,
      async profileBackground() {
        // Exercise the production queue with in-memory receipts only. This
        // excludes native IPC and disk, without contacting the app backend.
        const queue = createSaveQueue<number[], null>({ persist: async () => null });
        let update = new Uint8Array();
        const collect = (bytes: Uint8Array) => { update = bytes; };
        doc.on("update", collect); editor.commands.insertContent("x"); doc.off("update", collect);
        const samples: Record<string, number[]> = {};
        for (let i = 0; i < 10; i++) {
          for (const [name, run] of Object.entries({
            cards: () => extractCards(editor.state.doc),
            search: () => extractFromDoc(editor.state.doc),
            fullYjsSnapshot: () => Y.encodeStateAsUpdate(doc),
            incrementalSaveEnqueue: () => queue.enqueue("throwaway", Array.from(update)),
          })) {
            const start = performance.now(); run();
            (samples[name] ??= []).push(performance.now() - start);
          }
          await paint();
        }
        await queue.flush();
        return { incrementalUpdateBytes: update.length, samples };
      },
    });
    return stats;
  },
});
