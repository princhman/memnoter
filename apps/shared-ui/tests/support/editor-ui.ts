import type { Editor } from "@tiptap/core";
import { noteExtensions } from "@/lib/editor-schema";
import { InlineMathView } from "@/components/inline-math-view";
import { MathBlockView } from "@/lib/editor-schema/math-block-view";
import { SavedImage, InlineImage } from "@/components/saved-image";
import { SlashCommand } from "@/components/slash-menu";
import { LatexSuggest } from "@/components/latex-menu";

// Visible fixtures use the same node views and menus as Tiptap.
export function visibleNoteExtensions(
  options: Parameters<typeof noteExtensions>[0],
  menuOptions: { insertImages?: (editor: Editor, files: File[], position: number) => void; insertDrawing?: (editor: Editor) => void; nativeDrawing?: boolean } = {},
) {
  return noteExtensions({ ...options, ui: {
    inlineMath: InlineMathView, mathBlock: MathBlockView,
    savedImage: SavedImage, inlineImage: InlineImage,
    menus: [Object.keys(menuOptions).length ? SlashCommand.configure(menuOptions) : SlashCommand, LatexSuggest],
  } });
}
