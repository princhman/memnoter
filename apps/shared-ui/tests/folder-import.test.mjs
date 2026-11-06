import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import MarkdownIt from "markdown-it";
import { prepareFolderImport } from "../src/lib/folder-import.ts";
import { realPath, readFolder, all, synthetic } from "./support/import-fixture.mjs";
test("folder mapping, image deduplication, cell images, literal code and reporting", async () => {
  const plan = await prepareFolderImport(synthetic);
  assert.deepEqual(plan.notes, ["Course.md", "Week 2.md", "Week 10.md", "01 Notes/Week 2.md", "01 Notes/02 Deep/Extra.md"]);
  assert.deepEqual(all(plan.document, "heading").map(n => [n.content[0].text, n.attrs.level]), [["Week 2",1],["Week 10",1],["Notes",1],["Week 2",2],["Inner",3],["Deep",2],["Extra",3],["Deep heading",5]]);
  assert.equal(plan.images.length, 1);
  assert.equal(all(plan.document, "image").length, 2);
  assert.equal(all(plan.document, "tableCell").flatMap(n => all(n,"image"))[0].attrs.width, 300);
  assert.deepEqual(plan.skipped, ["empty/no.txt", "other.pdf"]);
  assert.deepEqual(plan.unresolved, []);
  assert.equal(all(plan.document,"codeBlock")[0].content[0].text, "a == b; [[raw]] $x$");
});
test("resolution prefers exact, note-relative, then shortest matching filename and reports unsupported images", async () => {
  const plan = await prepareFolderImport({ name: "X", entries: [
    {path:"notes/n.md",text:"![[a.png]] ![[local.png]] ![[long.png]] ![[missing.svg]]"},
    ...["a.png","notes/a.png","notes/local.png","deep/path/long.png","z/long.png"].map(path=>({path,bytes:[1]})),
  ] });
  assert.deepEqual(plan.images.map(e=>e.path), ["a.png","notes/local.png","z/long.png"]);
  assert.deepEqual(plan.unresolved, ["notes/n.md: missing.svg"]);
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
