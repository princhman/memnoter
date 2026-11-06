import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Toc from "@tiptap/extension-table-of-contents";
import { TableOfContents, createTocStore } from "@/components/table-of-contents";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/App.css";

const store = createTocStore();
const params = new URLSearchParams(location.search);
const level = params.has("relative") ? 2 : 1;
const weeks = params.has("short") ? 1 : 10;
const topics = params.has("short") ? 2 : 18;
function Outline() {
  const editor = useEditor({
    extensions: [StarterKit, Toc.configure({
      scrollParent: () => document.querySelector<HTMLElement>("main")!,
      onUpdate: (items) => store.setState(() => items),
    })],
    content: Array.from({ length: weeks }, (_, week) => `<h${level}>Week ${week + 1} - Intro to C Programming</h${level}>${Array.from({ length: topics }, (_, topic) => `<h${level + 1}>${topic === 10 ? "A long title about compilation and the many steps that a programmer takes to build a program" : `Week ${week + 1} course topic ${topic + 1}`}</h${level + 1}><p>${"A paragraph of note text explaining this part of the course. ".repeat(4)}</p><h${level + 2}>Week ${week + 1} topic ${topic + 1} details</h${level + 2}><p>Details of this course topic.</p><h${level + 3}>Week ${week + 1} topic ${topic + 1} example</h${level + 3}><p>A worked example.</p>`).join("")}`).join(""),
    onCreate: ({ editor }) => Object.assign(window, { editor, store }),
  });
  return <TooltipProvider><header style={{ height: 64, background: "var(--background)", position: "relative", zIndex: 40 }}>Programming notes</header><main className="app-scroll-container" style={{ height: "calc(100vh - 64px)", overflow: "auto", padding: "32px 64px" }}><EditorContent editor={editor} /><TableOfContents editor={editor} store={store} /></main></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Outline />);
