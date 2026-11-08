import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SHORTCUTS, action, bindsInJS, formatKeys, matchesShortcut } from "../src/lib/shortcuts.ts";

test("shortcut hints use consistent Apple and Windows/Linux notation", () => {
  for (const [keys, apple, other] of [
    ["Mod-Alt-s", "⌘⌥S", "Ctrl+Alt+S"],
    ["Mod-Shift-c", "⌘⇧C", "Ctrl+Shift+C"],
    ["Mod-,", "⌘,", "Ctrl+,"],
    ["Mod-Alt-[", "⌘⌥[", "Ctrl+Alt+["],
  ]) {
    assert.equal(formatKeys(keys, true), apple);
    assert.equal(formatKeys(keys, false), other);
  }
});

test("app shortcuts accept hardware Command and Control and reject extra modifiers", () => {
  const event = { key: "d", code: "KeyD", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(matchesShortcut(event, action("sidebar.toggle").keys), true);
  assert.equal(matchesShortcut({ ...event, metaKey: false, ctrlKey: true }, action("sidebar.toggle").keys), true);
  assert.equal(matchesShortcut({ ...event, altKey: true }, action("sidebar.toggle").keys), false);
  assert.equal(bindsInJS(action("sidebar.toggle"), true), false);
  assert.equal(bindsInJS(action("sidebar.toggle"), false), true);
  assert.equal(bindsInJS(action("module.new"), false), true);
  assert.equal(bindsInJS(action("settings.open"), false), true);
  assert.equal(bindsInJS(action("palette.open"), true), true);
});

// This is an independent cross-language contract: a Rust-only rename or
// accelerator change must fail even when each side still compiles on its own.
test("Rust menu dispatch IDs and accelerators match the shared action table", () => {
  const rust = readFileSync(new URL("../../desktop/src/menu.rs", import.meta.url), "utf8");
  const constants = new Map();
  for (const match of rust.matchAll(/const (\w+): \(&str, &str, &str\) = \("([^"]+)", "[^"]+", "([^"]+)"\);/g)) {
    constants.set(match[1], { id: match[2], accelerator: match[3] });
  }
  for (const match of rust.matchAll(/const (\w+): &str = "([^"]+)";/g)) constants.set(match[1], { id: match[2], accelerator: "" });
  const custom = rust.match(/const CUSTOM_ITEMS:[^=]+ = \[([\s\S]*?)\];/)[1];
  const native = custom.split(",").map((part) => part.trim()).filter(Boolean).map((name) => {
    const entry = constants.get(name.replace(/\.0$/, ""));
    assert.ok(entry, `unrecognized Rust custom menu item: ${name}`);
    return entry;
  });
  const expected = SHORTCUTS.filter((entry) => entry.menuId).map((entry) => ({
    id: entry.menuId,
    accelerator: entry.keys.split("-").map((key) => key === "Mod" ? "CmdOrCtrl" : key.length === 1 ? key.toUpperCase() : key).join("+"),
  }));
  assert.deepEqual(native.sort((a, b) => a.id.localeCompare(b.id)), expected.sort((a, b) => a.id.localeCompare(b.id)));
});
