import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatInterval,
  getScheduler,
  LEARN_AHEAD_MS,
  nextInQueue,
  previewDue,
  scheduleReview,
} from "../src/lib/fsrs.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const now = Date.UTC(2026, 0, 1);

// A card as `due_cards` returns it right after `sync_cards` created it.
function storedCard(overrides = {}) {
  return {
    id: "block:c1",
    moduleId: "m",
    moduleName: "Module",
    kind: "cloze",
    front: [],
    back: [],
    dueAt: now - DAY,
    stability: 0,
    stabilityFast: 0,
    difficulty: 0,
    scheduledDays: 0,
    learningStep: 0,
    state: 0,
    scheduleStatus: "new",
    lastReviewAt: null,
    reps: 0,
    lapses: 0,
    fsrsModel: null,
    ...overrides,
  };
}

test("a stored new card schedules with FSRS-7 and logs its pre-review state", async () => {
  const scheduler = await getScheduler();
  assert.equal(await getScheduler(), scheduler, "one scheduler per session");
  const { card, log } = scheduleReview(scheduler, storedCard(), 3, now, 4_000);

  assert.equal(card.reps, 1);
  assert.equal(card.lastReviewAt, now);
  assert.ok(card.stability > 0 && card.difficulty > 0);
  assert.ok(card.dueAt > now);
  assert.deepEqual(log, {
    dueAt: now - DAY,
    stability: 0,
    stabilityFast: 0,
    difficulty: 0,
    scheduledDays: 0,
    learningStep: 0,
    state: 0,
    scheduleStatus: "new",
    lastReviewAt: null,
    rating: 3,
    reviewTime: now,
    durationMs: 4_000,
    fsrsModel: "fsrs-7",
  });
  for (const value of Object.values(card)) {
    assert.ok(value === null || ["number", "string"].includes(typeof value), "plain values for IPC");
  }
});

test("button previews match the review that is then stored", async () => {
  const scheduler = await getScheduler();
  let stored = storedCard();
  let time = now;
  for (const rating of [3, 1, 3, 4, 2]) {
    const preview = previewDue(scheduler, stored, time);
    assert.ok(preview[1] < preview[2] && preview[2] <= preview[3] && preview[3] <= preview[4]);
    const { card } = scheduleReview(scheduler, stored, rating, time);
    assert.equal(card.dueAt, preview[rating]);
    // Round-trip through the stored shape, as the database returns it.
    stored = storedCard({ ...card });
    time = card.dueAt;
  }
  assert.equal(stored.reps, 5);
  assert.equal(stored.lapses, 1);
});

test("again brings a card back within the session", async () => {
  const scheduler = await getScheduler();
  const { card } = scheduleReview(scheduler, storedCard(), 1, now);
  assert.ok(card.dueAt - now <= LEARN_AHEAD_MS);
});

test("intervals are labelled like Anki's buttons", () => {
  assert.deepEqual(
    [10_000, MINUTE, 10 * MINUTE, 90 * MINUTE, 23 * 60 * MINUTE, DAY, 4.6 * DAY, 45 * DAY, 400 * DAY, 4000 * DAY].map(formatInterval),
    ["1m", "1m", "10m", "2h", "23h", "1d", "5d", "1.5mo", "1.1y", "11y"],
  );
});

test("the queue shows the most overdue card and learns ahead only when idle", () => {
  const queue = [
    { id: "later", dueAt: now + 10 * MINUTE },
    { id: "old", dueAt: now - DAY },
    { id: "older", dueAt: now - 2 * DAY },
  ];
  assert.equal(nextInQueue(queue, now).id, "older");
  assert.equal(nextInQueue(queue.slice(0, 1), now).id, "later");
  assert.equal(nextInQueue([{ id: "far", dueAt: now + DAY }], now), undefined);
  assert.equal(nextInQueue([], now), undefined);
});
