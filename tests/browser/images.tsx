import * as Y from "yjs";
import Collaboration from "@tiptap/extension-collaboration";
import { ImageMoveHistory } from "@/lib/image-move-history";
import { Flashcards } from "@/lib/flashcards";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SavedImage, InlineImage } from "@/components/saved-image";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/App.css";

function ImageEditor() {
  const editor = useEditor({
    extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: new Y.Doc() }), Flashcards, ImageMoveHistory, SavedImage, InlineImage],
    content: "<p>Image preview test</p>",
    onCreate: ({ editor }) => Object.assign(window, { editor }),
  });
  return <TooltipProvider><EditorContent editor={editor} /></TooltipProvider>;
}

createRoot(document.getElementById("root")!).render(<ImageEditor />);
