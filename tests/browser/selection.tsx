import * as Y from "yjs";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { noteExtensions } from "@/lib/note-extensions";
import { TextBubbleMenu } from "@/components/text-bubble-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@fontsource-variable/inter";
import "@fontsource-variable/dm-sans";
import "@/App.css";
function SelectionEditor() {
  const editor = useEditor({ extensions: noteExtensions({ document: new Y.Doc() }), onCreate: ({ editor }) => Object.assign(window, { editor }) });
  return <TooltipProvider><div style={{ width: 772.8, margin: "40px auto" }}><EditorContent editor={editor} /><TextBubbleMenu editor={editor} /></div></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<SelectionEditor />);
