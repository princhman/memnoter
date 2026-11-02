// Project style rules no installed linter covers:
//   em-dash        no em dashes, in code, comments, docs or UI text;
//   middle-dot     no dot symbols (· • ⋅) used as separators within text;
//   surface-outline  no outline around floating surfaces (popups, popovers,
//                  menus, dialogs, tooltips) or cards, including tinted
//                  buttons: their shadow or background sets them apart.
//                  Dividers inside them are fine.
// A line containing `lint-allow: <rule>` is exempt, for text that has to show
// the character itself.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.resolve("vite"));
const postcss = require("postcss");

const CHECKED = /\.(ts|tsx|mjs|js|css|md|rs|html)$/;
const SKIPPED = /(^|\/)(node_modules|dist|target)\/|routeTree\.gen\.ts$|pnpm-lock/;
// Floating surfaces, by the class names this project gives them.
const SURFACE = /popup|popover|menu|dialog|tooltip|toast|card-face/;
// Tailwind classes that draw a ring around a surface, as shadcn outlines do.
const RING_CLASS = /(?<![\w-])(?:[\w-]+:)*ring-(?:1|px|foreground\/\d+|border|sidebar-border)(?![\w/-])/;
// A border on all four sides; on a rounded box that outlines a card. The
// shadcn primitives in components/ui keep theirs: inputs and outline buttons
// are controls, not cards.
const BORDER_CLASS = /(?<![\w-])(?:[\w-]+:)*border(?:-(?:current|border|foreground|input|sidebar-border)(?:\/\d+)?)?(?![\w/-])/;
const ROUNDED_CLASS = /(?<![\w-])(?:[\w-]+:)*rounded(?:-[\w]+)?(?![\w/-])/;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => CHECKED.test(file) && !SKIPPED.test(file) && file !== "scripts/lint-style.mjs");

const problems = [];
const report = (file, line, rule, message) => {
  const text = lines.get(file)?.[line - 1] ?? "";
  if (!text.includes(`lint-allow: ${rule}`)) problems.push(`${file}:${line}  ${rule}  ${message}`);
};
const lines = new Map();

for (const file of files) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue; // Deleted but not yet staged.
  }
  lines.set(file, source.split("\n"));

  lines.get(file).forEach((text, index) => {
    if (text.includes("—")) report(file, index + 1, "em-dash", "use a comma, colon or full stop");
    if (/[·•⋅]/.test(text)) {
      report(file, index + 1, "middle-dot", "write the parts as words, or split them");
    }
    if (/\.(tsx?|jsx?)$/.test(file) && RING_CLASS.test(text)) {
      report(file, index + 1, "surface-outline", `"${text.match(RING_CLASS)[0]}" outlines a surface`);
    }
    if (
      /\.(tsx?|jsx?)$/.test(file) &&
      !file.startsWith("src/components/ui/") &&
      BORDER_CLASS.test(text) &&
      ROUNDED_CLASS.test(text)
    ) {
      report(file, index + 1, "surface-outline", `"${text.match(BORDER_CLASS)[0]}" outlines a card`);
    }
  });

  if (file.endsWith(".css")) {
    postcss.parse(source, { from: file }).walkRules((rule) => {
      // The surface itself, not a control inside it such as `.dialog input`.
      const subjects = rule.selectors.map((selector) => selector.trim().split(/[\s>+~]+/).pop());
      if (!subjects.some((subject) => SURFACE.test(subject))) return;
      rule.each((decl) => {
        if (decl.type !== "decl") return;
        const value = decl.value.trim();
        const outlines =
          (["border", "outline"].includes(decl.prop) && !/^(none|0)\b/.test(value)) ||
          (decl.prop === "box-shadow" && /\b0 0 0 1px\b/.test(value));
        if (outlines) {
          report(file, decl.source.start.line, "surface-outline",
            `${decl.prop} outlines "${rule.selector.replace(/\s+/g, " ")}"`);
        }
      });
    });
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} style problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
