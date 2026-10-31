import assert from "node:assert/strict";
import { test } from "node:test";
import { getCommands, matchesCommand, registerCommand } from "../src/lib/commands.ts";

test("registering an id replaces it, and only the current registration removes it", () => {
  const first = registerCommand({ id: "x", title: "First", run() {} });
  const second = registerCommand({ id: "x", title: "Second", run() {} });
  assert.deepEqual(getCommands().map((command) => command.title), ["Second"]);
  first();
  assert.equal(getCommands().length, 1);
  second();
  assert.equal(getCommands().length, 0);
});

test("every query word must start a word of the title or keywords", () => {
  const command = { id: "module.new", title: "New module", keywords: ["create"], run() {} };
  for (const query of ["new", "mod", "NEW MOD", "create", "cr mo", ""]) {
    assert.ok(matchesCommand(command, query), query);
  }
  for (const query of ["odule", "new x", "sidebar"]) {
    assert.ok(!matchesCommand(command, query), query);
  }
});
