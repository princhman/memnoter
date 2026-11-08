import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { basicCardId, clozeCardId, occlusionCardId, parseCardId, blockIdOf, siblingOf } from "../src/lib/card-id.ts";

const golden = JSON.parse(readFileSync(new URL("../../../crates/memnoter-core/tests/fixtures/card-ids.json", import.meta.url)));
test("persisted card IDs retain their exact bytes and opaque cloze suffixes", () => {
  for (const row of golden) {
    const parsed = parseCardId(row.id);
    assert.equal(parsed.kind, row.kind);
    assert.equal(blockIdOf(row.id), row.blockId);
    assert.equal(siblingOf(row.id), row.sibling);
    const rebuilt = parsed.kind === "basic" ? basicCardId(parsed.blockId, parsed.reverse)
      : parsed.kind === "cloze" ? clozeCardId(parsed.blockId, parsed.clozeId)
      : occlusionCardId(parsed.blockId, parsed.maskId);
    assert.equal(rebuilt, row.id);
  }
});
