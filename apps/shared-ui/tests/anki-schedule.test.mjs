import assert from "node:assert/strict";
import { test } from "node:test";
import { ankiHistory } from "../src/lib/anki-schedule.ts";
import { getScheduler, scheduleReview } from "../src/lib/fsrs.ts";

const anki = { ord: 0, kind: "review", suspended: false, due: 1800000000000, intervalDays: 100, ease: 2.5, reps: 12, lapses: 2, reviews: [] };
test("SM-2 history fallback preserves dates and counters and converts ease to difficulty", async () => {
  for (const [ease, expected] of [[1.3, 9.8], [2.5, 5]]) {
    const history = await ankiHistory({ cardId: "a", anki: { ...anki, ease } });
    assert.equal(history.card.stability, 100);
    assert.equal(history.card.stabilityFast, 80);
    assert.ok(Math.abs(history.card.difficulty - expected) < 0.25);
    assert.equal(history.card.lastReviewAt, anki.due - 100 * 86400000);
    assert.equal(history.card.reps, 12);
    assert.equal(history.card.lapses, 2);
    assert.equal(history.logs.length, 0);
  }
  for (const kind of ["new", "learning"]) assert.equal(await ankiHistory({ cardId: "a", anki: { ...anki, kind } }), null);
  assert.equal(await ankiHistory({ cardId: "a", anki: { ...anki, suspended: true, reviews: [{ time: 1700000000000, rating: 3 }] } }), null);
});
test("historic answers replay through FSRS and the resulting card can be reviewed again", async () => {
  const reviews = [{ time: 1700000000000, rating: 3 }, { time: 1700086400000, rating: 4 }, { time: 1701000000000, rating: 1 }];
  const history = await ankiHistory({ cardId: "a", anki: { ...anki, reviews } });
  assert.deepEqual(history.logs.map(l => [l.reviewTime, l.rating]), reviews.map(r => [r.time, r.rating]));
  assert.equal(history.logs[0].state, 0);
  assert.equal(history.card.reps, 3);
  assert.equal(history.card.lastReviewAt, reviews[2].time);
  const next = scheduleReview(await getScheduler(), { ...history.card, id: "a" }, 3, 1701000060000);
  assert.equal(next.card.reps, 4);
  assert.ok(Number.isFinite(next.card.dueAt));
});
