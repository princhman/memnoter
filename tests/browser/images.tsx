import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SavedImage, InlineImage } from "@/components/saved-image";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/App.css";

function ImageEditor() {
  const editor = useEditor({
    extensions: [StarterKit, SavedImage, InlineImage],
    content: "<p>Image preview test</p>",
    onCreate: ({ editor }) => Object.assign(window, { editor }),
  });
  return <TooltipProvider><EditorContent editor={editor} /></TooltipProvider>;
}

createRoot(document.getElementById("root")!).render(<ImageEditor />);
