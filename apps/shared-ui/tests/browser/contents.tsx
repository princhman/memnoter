import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { InlineMath } from "@/lib/inline-math";
import Toc from "@tiptap/extension-table-of-contents";
import { TableOfContents, createTocStore } from "@/components/table-of-contents";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/App.css";

const store = createTocStore();
const params = new URLSearchParams(location.search);
const level = params.has("relative") ? 2 : 1;
const weeks = params.has("short") ? 2 : 10;
const topics = params.has("short") ? 2 : 18;
function topicContent(week: number, topic: number) {
  const title = topic === 10 ? "A long title about compilation and the many steps that a programmer takes to build a program" : `Week ${week + 1} course topic ${topic + 1}`;
  const count = params.has("deep") && week === 0 && topic === 0 ? 24 : 1;
  return `<h${level + 1}>${title}</h${level + 1}><p>${"A paragraph of note text explaining this part of the course. ".repeat(4)}</p>${Array.from({ length: count }, (_, index) => {
    const suffix = index === 0 ? "" : ` ${index + 1}`;
    return `<h${level + 2}>Week ${week + 1} topic ${topic + 1} details${suffix}</h${level + 2}><p>Details of this course topic.</p><h${level + 3}>Week ${week + 1} topic ${topic + 1} example${suffix}</h${level + 3}><p>A worked example.</p>`;
  }).join("")}`;
}
const content = Array.from({ length: weeks }, (_, week) => {
  const direct = params.has("direct") && week === 0 ? `<h${level + 2}>Direct details</h${level + 2}><p>Details belonging to the week itself.</p><h${level + 3}>Direct example</h${level + 3}><p>A direct example.</p>` : "";
  return `<h${level}>Week ${week + 1} - Intro to C Programming</h${level}>${direct}${Array.from({ length: topics }, (_, topic) => topicContent(week, topic)).join("")}`;
}).join("");
function Outline() {
  const editor = useEditor({
    extensions: [StarterKit, InlineMath, Toc.configure({
      scrollParent: () => document.querySelector<HTMLElement>("main")!,
      onUpdate: (items) => store.setState(() => items),
    })],
    content: `<p>Introduction before the first section.</p>${content}`,
    onCreate: ({ editor }) => Object.assign(window, { editor, store }),
  });
  return <TooltipProvider><header style={{ height: 64, background: "var(--background)", position: "relative", zIndex: 40 }}>Programming notes</header><main className="app-scroll-container" style={{ height: "calc(100vh - 64px)", overflow: "auto", padding: "32px 64px" }}><EditorContent editor={editor} /><TableOfContents editor={editor} store={store} numbered={params.has("numbered")} /></main></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Outline />);
