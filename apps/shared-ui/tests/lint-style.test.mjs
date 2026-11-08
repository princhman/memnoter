// The style check finds each rule's problem, and honours `lint-allow`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/lint-style.mjs", import.meta.url));

function lint(files) {
  const dir = mkdtempSync(join(tmpdir(), "lint-style-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const { status, stderr } = spawnSync("node", [script], { cwd: dir, encoding: "utf8" });
    return { status, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("each rule is reported with its file and line", () => {
  const { status, stderr } = lint({
    "a.ts": 'const a = "one \u2014 two";\nconst b = "Small \u00B7 25%";\n',
    "b.tsx": 'export const c = <div className="rounded-lg ring-1 ring-foreground/10" />;\n',
    "c.css": ".floating-surface {\n  border: 1px solid red;\n}\n.list {\n  border: 1px solid red;\n}\n",
    "d.tsx": 'const pill = "rounded-xl border border-current/10 bg-red-500/10";\n',
  });
  assert.equal(status, 1);
  assert.match(stderr, /a\.ts:1 {2}em-dash/);
  assert.match(stderr, /a\.ts:2 {2}middle-dot/);
  assert.match(stderr, /b\.tsx:1 {2}surface-outline/);
  assert.match(stderr, /c\.css:2 {2}surface-outline/);
  assert.match(stderr, /d\.tsx:1 {2}surface-outline/);
  // Only floating surfaces lose their outline.
  assert.doesNotMatch(stderr, /c\.css:5/);
});

test("clean files and allowed lines pass", () => {
  const { status, stderr } = lint({
    "a.ts": 'const a = "f(\u2022)"; // lint-allow: middle-dot\n',
    "c.css": ".floating-surface {\n  border: none;\n  border-top: 1px solid red;\n}\n.floating-surface input {\n  border: 1px solid red;\n}\n",
    "d.tsx": 'const header = "rounded-lg border-b border-0 px-3";\n',
  });
  assert.equal(status, 0, stderr);
});

test("surface outline shadows are rejected", () => {
  for (const shadow of [
    "inset 0 0 0 1px var(--surface-edge), 0 4px 16px black",
    "0 0 0 1px var(--surface-edge)",
    "inset 0 0 0 1px red",
    "inset 0 0 0 1px var(--surface-edge), 0 0 0 1px red",
  ]) {
    const rejected = lint({ "a.css": `.floating-surface { box-shadow: ${shadow}; }` });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /surface-outline/);
  }
});
