import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";

// Paragraphs retain flashcard identities and allow all inline content, including
// math and inline images. Block images are also supported. Keeping headings,
// lists and nested tables out avoids introducing sections inside a cell.
const cellContent = "(paragraph | image)+";

export const NoteTables = [
  // Upstream resizing uses mouse events, so omit it on our touch-first editor.
  Table.configure({ resizable: false, renderWrapper: true, cellMinWidth: 112 }),
  TableRow,
  TableHeader.extend({ content: cellContent }),
  TableCell.extend({ content: cellContent }),
];
