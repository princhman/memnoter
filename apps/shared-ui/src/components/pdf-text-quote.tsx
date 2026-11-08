import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { PdfTextQuote as PdfTextQuoteSchema } from "@/lib/editor-schema/pdf-text-quotes";
import { PdfSourceCaption } from "./pdf-source-caption";

function PdfTextQuoteView({ node }: NodeViewProps) {
  return <NodeViewWrapper className="my-3 border-l-2 border-primary pl-3">
    <NodeViewContent />
    <PdfSourceCaption value={node.attrs.pdfSource} />
  </NodeViewWrapper>;
}

export const PdfTextQuote = PdfTextQuoteSchema.extend({
  addNodeView() { return ReactNodeViewRenderer(PdfTextQuoteView); },
});
