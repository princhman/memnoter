import { test } from "node:test";
import assert from "node:assert/strict";
import { pointInTriangle } from "../src/lib/menu-aim.ts";

test("menu aim retains points inside the popup triangle and releases points outside", () => {
  const origin = { x: 100, y: 50 };
  const top = { x: 0, y: 0 };
  const bottom = { x: 0, y: 100 };
  assert.equal(pointInTriangle({ x: 50, y: 60 }, origin, top, bottom), true);
  assert.equal(pointInTriangle({ x: 50, y: 90 }, origin, top, bottom), false);
  assert.equal(pointInTriangle({ x: 110, y: 50 }, origin, top, bottom), false);
  assert.equal(pointInTriangle({ x: 0, y: 75 }, origin, top, bottom), true);
  assert.equal(pointInTriangle({ x: 50, y: 60 }, origin, bottom, top), true);
  assert.equal(pointInTriangle({ x: 0, y: 50 }, { x: 0, y: 20 }, top, bottom), false);
});
