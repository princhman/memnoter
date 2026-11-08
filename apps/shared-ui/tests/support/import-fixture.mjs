import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { imageMime } from "../../src/lib/folder-import.ts";
export const realPath = process.env.MEMNOTER_IMPORT_FOLDER ?? "/Users/vladyslavnalyvaiko/Downloads/COMP0002 - Principles of Programming";
export function readFolder(root) {
  const entries = [];
  function walk(dir, prefix = "") {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
      const path = prefix + item.name, full = join(dir, item.name);
      if (item.isDirectory()) walk(full, path + "/");
      else entries.push({ path, ...(/\.md$/i.test(path) ? { text: readFileSync(full, "utf8") } : imageMime(path) ? { bytes: [...readFileSync(full)] } : {}) });
    }
  }
  walk(root);
  return { name: basename(root), entries };
}
export function all(node, type) { return [...(node.type === type ? [node] : []), ...(node.content ?? []).flatMap(n => all(n, type))]; }
export const synthetic = { name: "Course", entries: [
  { path: "Course.md", text: "Welcome" },
  { path: "Week 10.md", text: "last" },
  { path: "Week 2.md", text: "Module: [[Course]]\n==yellow== [[alias|visible]]\n\n```c\na == b; [[raw]] $x$\n```" },
  { path: "01 Notes/Week 2.md", text: "# Inner\n\n| Image | Text |\n|---|---|\n| ![[a.png\\|300]] | ==cell== |\n\n![alt](../attachments/a.png)" },
  { path: "01 Notes/02 Deep/Extra.md", text: "## Deep heading" },
  { path: "attachments/a.png", bytes: [137,80,78,71] },
  { path: "other.pdf" }, { path: "empty/no.txt" }, { path: ".trash/hidden.md", text: "hidden" },
] };
