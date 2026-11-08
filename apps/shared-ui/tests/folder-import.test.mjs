import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import MarkdownIt from "markdown-it";
import { prepareFolderImport } from "../src/lib/folder-import.ts";
import { realPath, readFolder, all, synthetic } from "./support/import-fixture.mjs";
test("folder mapping, image deduplication, cell images, literal code and reporting", async () => {
  const plan = await prepareFolderImport(synthetic);
  assert.deepEqual(plan.notes, ["Course.md", "Week 2.md", "Week 10.md", "01 Notes/Week 2.md", "01 Notes/02 Deep/Extra.md"]);
  assert.deepEqual(all(plan.document, "heading").map(n => [n.content[0].text, n.attrs.level]), [["Week 2",1],["Week 10",1],["Notes",1],["Week 2",2],["Inner",3],["Deep",2],["Extra",3],["Deep heading",4]]);
  assert.equal(plan.images.length, 1);
  assert.equal(all(plan.document, "image").length, 2);
  assert.equal(all(plan.document, "tableCell").flatMap(n => all(n,"image"))[0].attrs.width, 300);
  assert.deepEqual(plan.skipped, ["empty/no.txt", "other.pdf"]);
  assert.deepEqual(plan.unresolved, []);
  assert.equal(all(plan.document,"codeBlock")[0].content[0].text, "a == b; [[raw]] $x$");
});
test("resolution prefers exact, note-relative, then unambiguous filename and reports unsupported images", async () => {
  const plan = await prepareFolderImport({ name: "X", entries: [
    {path:"notes/n.md",text:"![[a.png]] ![[local.png]] ![[long.png]] ![[missing.svg]]"},
    ...["a.png","notes/a.png","notes/local.png","deep/path/long.png","z/long.png"].map(path=>({path,bytes:[1]})),
  ] });
  assert.deepEqual(plan.images.map(e=>e.path), ["a.png","notes/local.png"]);
  assert.deepEqual(plan.unresolved, ["notes/n.md: long.png (ambiguous)","notes/n.md: missing.svg"]);
});
test("real read-only Obsidian folder preserves every note, fence and prose markup", { skip: !existsSync(realPath) }, async () => {
  const folder = readFolder(realPath), plan = await prepareFolderImport(folder);
  const parser = new MarkdownIt();
  const fences = folder.entries.filter(e=>e.text !== undefined).flatMap(e=>parser.parse(e.text,{}).filter(t=>t.type === "fence" || t.type === "code_block").map(t=>t.content.replace(/\n$/, "")));
  assert.equal(plan.notes.length, 22);
  const sourceHighlights = folder.entries.filter(e=>e.text !== undefined).flatMap(e=>parser.parse(e.text,{}).filter(t=>t.type === "inline")).reduce((count,t)=>count + [...(t.children??[]).filter(t=>t.type === "text").map(t=>t.content).join("").matchAll(/==(?=\S)([\s\S]+?)==/g)].length, 0);
  assert.equal(all(plan.document,"text").filter(n=>n.marks?.some(m=>m.type === "highlight")).length, sourceHighlights);
  const weeks = plan.notes.filter(n=>/^01 .*\/Week \d+/.test(n)).map(n=>Number(/Week (\d+)/.exec(n)[1]));
  assert.deepEqual(weeks, Array.from({length:10},(_,i)=>i+1));
  assert.equal(new Set(plan.notes).size, folder.entries.filter(e=>e.text !== undefined).length);
  assert.equal(plan.notes[0], `${folder.name}.md`);
  assert.deepEqual(all(plan.document,"codeBlock").map(n=>n.content?.[0]?.text ?? "").sort(), fences.sort());
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.images.length, 7);
  const prose = node => node.type === "codeBlock" || node.type === "inlineMath" || node.type === "mathBlock" || node.marks?.some(m=>m.type === "code") ? "" : (node.text ?? "") + (node.content??[]).map(prose).join("");
  assert.doesNotMatch(prose(plan.document), /==|!?\[\[/);
  console.log("REAL_IMPORT", JSON.stringify({ notes: plan.notes, images: all(plan.document,"image").length, uniqueImages:plan.images.length, highlights:all(plan.document,"text").filter(n=>n.marks?.some(m=>m.type === "highlight")).length, codeBlocks:fences.length, skipped:plan.skipped }));
});

test("Markdown relative image paths select the note's image rather than a root namesake", async () => {
  const plan = await prepareFolderImport({ name: "X", entries: [
    { path: "notes/n.md", text: "![local](a.png) ![explicit](./a.png) ![[a.png]]" },
    { path: "a.png", bytes: [1] }, { path: "notes/a.png", bytes: [2] },
  ] });
  assert.deepEqual(all(plan.document, "image").map(n => n.attrs.fileId), ["notes/a.png", "notes/a.png", "a.png"]);
});

test("plan obeys selected order and exclusion, resolves extra images safely and preserves peer heading levels", async () => {
  const folder = { name: "Vault", entries: [
    { path: "a.md", text: "topic: [[Vault]]\n\n## Module Info\n\n## Aims\n\n![[picture.png]] ![[wrong/picture.png]] ![[duplicate.png]]" },
    { path: "group/b.md", text: "B" }, { path: "c.md", text: "Excluded" },
  ] };
  const plan = await prepareFolderImport(folder, () => {}, { order: ["group/b.md", "a.md", "c.md"], excluded: ["c.md"], extraImages: [
    { path: "assets/picture.png", bytes: [1], sourceId: "extra" },
    { path: "one/duplicate.png", bytes: [2] }, { path: "two/duplicate.png", bytes: [3] },
  ] });
  assert.deepEqual(plan.notes, ["group/b.md", "a.md"]);
  assert.equal(plan.resolvedReferences, 1);
  assert.deepEqual(plan.imageIssues, [{ note: "a.md", target: "wrong/picture.png", ambiguous: false }, { note: "a.md", target: "duplicate.png", ambiguous: true }]);
  assert.deepEqual(all(plan.document, "heading").slice(-2).map(n => n.attrs.level), [2, 2]);
  assert.match(all(plan.document, "text").map(n => n.text).join(" "), /topic: Vault/);
  assert.equal(plan.images[0].path, "extra/assets/picture.png");
});

test("formatting removes navigation and unsupported embeds while retaining code and optional YAML", async () => {
  const folder = { name: "Vault", entries: [{ path: "a.md", text: '---\nowner: Me\n---\nup: [[Vault]]\n\n[[Other]]\n[Other](other.md)\n\nRead [[Other|this]] and [that](other.md).\n\n![[slides.pdf#page=52]]\n\n`![[code.pdf]]`\n\n```md\n[[Other]]\n```' }] };
  const plan = await prepareFolderImport(folder);
  const prose = all(plan.document, "text").map(n => n.text).join("");
  assert.doesNotMatch(prose, /owner:|up:|slides.pdf|\[embed:/);
  assert.match(prose, /Read this and that\./);
  assert.match(prose, /!\[\[code.pdf\]\]/);
  assert.equal(all(plan.document, "text").filter(n => n.marks?.some(m => m.type === "link")).length, 0);
  const kept = await prepareFolderImport(folder, () => {}, { keepFrontMatter: true, removeNoteLinks: false, removeUnsupportedEmbeds: false });
  assert.equal(all(kept.document, "codeBlock")[0].content[0].text, "owner: Me");
  assert.ok(all(kept.document, "text").some(n => n.text.includes("[embed: slides.pdf#page=52]")));
  assert.ok(all(kept.document, "text").some(n => n.marks?.some(m => m.type === "link")));
});


test("vault root note keeps its outline while peer headings normalize together", async () => {
  const folder = { name: "Vault", entries: [{ path: "Vault.md", text: "## Module Info\n\n## Aims" }] };
  const plan = await prepareFolderImport(folder);
  assert.deepEqual(all(plan.document, "heading").map(n => [n.content[0].text, n.attrs.level]), [["Module Info", 1], ["Aims", 1]]);
});

test("a picked image folder resolves references qualified with that folder's name", async () => {
  const folder = { name: "Vault", entries: [
    { path: "notes/n.md", text: "![[attachments/pic.png]]\n\n![pic](../attachments/pic.png)\n\n![[other/pic.png]]" },
  ] };
  // The user picks `attachments`; its entries are relative to that folder.
  const plan = await prepareFolderImport(folder, () => {}, { extraImages: [{ path: "pic.png", sourceId: "extra" }], extraImageFolder: "attachments" });
  assert.equal(plan.resolvedReferences, 2);
  assert.deepEqual(plan.imageIssues, [{ note: "notes/n.md", target: "other/pic.png", ambiguous: false }]);
});
