import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeHref } from "../src/lib/link-editor.ts";

test("bare hosts get https, including ones with a port", () => {
  assert.equal(normalizeHref("example.com"), "https://example.com");
  assert.equal(normalizeHref("example.com:8080/path"), "https://example.com:8080/path");
  assert.equal(normalizeHref("localhost:3000"), "https://localhost:3000");
});

test("schemes and addresses are kept or mailto'd", () => {
  assert.equal(normalizeHref("http://example.com:8080"), "http://example.com:8080");
  assert.equal(normalizeHref("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(normalizeHref("tel:5551234"), "tel:5551234");
  assert.equal(normalizeHref("a@b.co"), "mailto:a@b.co");
  assert.equal(normalizeHref("  "), "");
});
