import assert from "node:assert/strict";
import test from "node:test";
import { jsonToMarkdown } from "../src/lib/markdown-export.ts";
import { markdownToJSON } from "../src/lib/markdown-paste.ts";

const text = value => ({ type: "text", text: value });
const paragraph = (...content) => ({ type: "paragraph", content });

test("exports notes as Obsidian Markdown with Memnoter card syntax", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Motion")] },
      paragraph(text("Distance :: "), { type: "inlineMath", content: [text("vt")] }),
      paragraph(text("Acceleration ::: Change in velocity")),
      paragraph(text("Units are {{meters per second}}.")),
      { type: "mathBlock", content: [text(String.raw`a = \frac{v}{t}`)] },
      paragraph(text("What is required? ::list")),
      { type: "bulletList", content: [{ type: "listItem", content: [
        paragraph(text("Distance")),
        { type: "orderedList", attrs: { start: 2 }, content: [
          { type: "listItem", content: [paragraph(text("Time"))] },
        ] },
      ] }] },
      paragraph(text("::end")),
      { type: "image", attrs: { fileId: "image-id", alt: "Motion [graph]" } },
    ],
  };
  const makeImage = id => {
    assert.equal(id, "image-id");
    return "attachments/Motion (graph).png";
  };
  const markdown = jsonToMarkdown(doc, makeImage);
  assert.equal(markdown, String.raw`## Motion

Distance :: $vt$

Acceleration ::: Change in velocity

Units are {{meters per second}}.

$$
a = \frac{v}{t}
$$

What is required? ::list

- Distance

  2. Time

::end

![Motion \[graph\]](attachments/Motion%20%28graph%29.png)`);
  const imported = markdownToJSON(markdown, (path, alt) => {
    assert.equal(decodeURIComponent(path), makeImage("image-id"));
    assert.ok(alt.startsWith("Motion"));
    return { type: "image", attrs: { fileId: "image-id" } };
  });
  assert.deepEqual(imported.content[1], doc.content[1]);
  assert.deepEqual(imported.content[3], doc.content[3]);
  assert.deepEqual(imported.content[4], doc.content[4]);
  assert.equal(imported.content.at(-1).attrs.fileId, "image-id");
});

test("keeps a multiline cloze answer in a display math block", () => {
  const formula = String.raw`a = \frac{v}{t}
b = a + 1`;
  const markdown = jsonToMarkdown({ type: "doc", content: [
    { type: "mathBlock", attrs: { cloze: true }, content: [text(formula)] },
  ] }, () => "");
  assert.equal(markdown, `**Cloze answer**\n\n$$\n${formula}\n$$`);
  assert.deepEqual(markdownToJSON(markdown).content.at(-1), {
    type: "mathBlock", content: [text(formula)],
  });
});

test("preserves trailing hashes in heading text through Markdown parsing", () => {
  const heading = { type: "heading", attrs: { level: 2 }, content: [text("Version ###")] };
  const markdown = jsonToMarkdown({ type: "doc", content: [heading] }, () => "");
  assert.deepEqual(markdownToJSON(markdown).content, [heading]);
});

test("backup diff separates adjacent changes and leaves rich blocks read-only", async () => {
  const { diffBackupNote } = await import("../src/lib/backup-edit-diff.ts");
  const current = {
    type: "doc",
    content: [paragraph(text("First")), paragraph(text("Second")),
      { type: "image", attrs: { fileId: "graph", alt: "Graph", masks: [{ id: "mask" }] } }],
  };
  const hunks = diffBackupNote({
    current,
    edited: "First update\n\nSecond update\n\n![Other](attachments/graph.png)\n",
    imagePath: id => `attachments/${id}.png`,
    pdfAppendix: "",
  });
  assert.deepEqual(hunks.map(hunk => [hunk.from, hunk.to, hunk.before, hunk.after, Boolean(hunk.reason)]), [
    [0, 1, "First", "First update", false],
    [1, 2, "Second", "Second update", false],
    [2, 3, "![Graph](attachments/graph.png)", "![Other](attachments/graph.png)", true],
  ]);
});
