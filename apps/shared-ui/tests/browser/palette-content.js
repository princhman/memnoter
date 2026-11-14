export async function paletteContent() {
      const { getSchema } = await import("@tiptap/core");
      const { noteExtensions } = await import("/src/lib/editor-schema.ts");
      const { prosemirrorJSONToYDoc } = await import("@tiptap/y-tiptap");
      const Y = await import("yjs");
      const temp = new Y.Doc();
      const schema = getSchema(noteExtensions({ document: temp }));
      const heading = (level, text, id) => ({ type: "heading", attrs: { level, "data-toc-id": id }, content: [{ type: "text", text }] });
      const paragraph = { type: "paragraph", content: [{ type: "text", text: "Section body ".repeat(60) }] };
      const doc = prosemirrorJSONToYDoc(schema, { type: "doc", content: [heading(1, "Foundations", "foundations"), paragraph, heading(2, "Numbers", "numbers"), paragraph, heading(3, "Integers", null), paragraph, heading(2, "Equations", "equations"), ...Array(10).fill(paragraph), heading(1, "Geometry", "geometry"), paragraph] }, "default");
      const saved = Array.from(Y.encodeStateAsUpdate(doc)); doc.destroy(); temp.destroy();
      return saved;
}
