import assert from "node:assert/strict";
import { test } from "node:test";
import { createSaveQueue } from "../src/lib/save-queue.ts";

// Manually advanced clock, so backoff runs without real waiting.
function fakeTimers() {
  let time = 0;
  let timers = [];
  return {
    timers: {
      now: () => time,
      setTimeout: (callback, ms) => {
        const timer = { at: time + ms, callback };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timers = timers.filter((other) => other !== timer);
      },
    },
    delays: () => timers.map((timer) => timer.at - time),
    async advance(ms) {
      time += ms;
      const due = timers.filter((timer) => timer.at <= time);
      timers = timers.filter((timer) => timer.at > time);
      for (const timer of due) timer.callback();
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ failures = 0 } = {}) {
  const clock = fakeTimers();
  const persisted = [];
  const saved = [];
  const statuses = [];
  let remainingFailures = failures;
  let nextId = 1;
  const queue = createSaveQueue({
    persist: async (moduleId, update) => {
      await settle();
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("database is locked");
      }
      persisted.push(`${moduleId}:${update}`);
      return nextId++;
    },
    onSaved: (moduleId, id) => saved.push([moduleId, id]),
    onStatus: (status) => statuses.push(status),
    timers: clock.timers,
  });
  return {
    clock,
    queue,
    persisted,
    saved,
    statuses,
    fail: (count) => {
      remainingFailures = count;
    },
  };
}

test("updates are persisted one at a time in order", async () => {
  const { queue, persisted, saved } = setup();
  for (const update of ["a", "b", "c"]) queue.enqueue("note", update);
  assert.deepEqual(queue.pending("note"), ["a", "b", "c"]);
  assert.equal(await queue.flush(), true);
  assert.deepEqual(persisted, ["note:a", "note:b", "note:c"]);
  assert.deepEqual(saved, [["note", 1], ["note", 2], ["note", 3]]);
  assert.equal(queue.isEmpty(), true);
});

test("failed updates are kept and retried in order with doubling backoff", async () => {
  const { clock, queue, persisted, statuses } = setup({ failures: 4 });
  queue.enqueue("note", "a");
  queue.enqueue("note", "b");
  await settle();
  const delays = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    await settle();
    delays.push(...clock.delays());
    await clock.advance(clock.delays()[0]);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000]);
  await settle();
  await settle();
  assert.deepEqual(persisted, ["note:a", "note:b"]);
  assert.equal(queue.isEmpty(), true);
  // Banner only after repeated failures, and cleared once saved.
  const failingFrom = statuses.findIndex((status) => status.failing);
  assert.equal(statuses.filter((s) => !s.failing && s.lastError).length, 0);
  assert.ok(failingFrom > 0);
  assert.equal(statuses[failingFrom].lastError, "database is locked");
  assert.deepEqual(statuses.at(-1), { pending: 0, failing: false, lastError: null });
});

test("backoff is capped at 30 seconds", async () => {
  const { clock, queue } = setup({ failures: 20 });
  queue.enqueue("note", "a");
  let delay = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    await settle();
    await settle();
    delay = clock.delays()[0];
    await clock.advance(delay);
  }
  assert.equal(delay, 30_000);
  assert.equal(queue.status().failing, true);
});

test("retry and flush skip the backoff wait", async () => {
  const { queue, persisted, fail } = setup({ failures: 1 });
  queue.enqueue("note", "a");
  await settle();
  await settle();
  assert.deepEqual(persisted, []);
  assert.equal(await queue.flush(), true);
  assert.deepEqual(persisted, ["note:a"]);

  fail(1);
  queue.enqueue("note", "b");
  assert.equal(await queue.flush(), false);
  assert.deepEqual(queue.pending("note"), ["b"]);
  assert.equal(await queue.flush(), true);
});

test("compaction is gated until the module has nothing queued or in flight", async () => {
  const { queue } = setup({ failures: 1 });
  assert.equal(queue.isIdle("note"), true);
  queue.enqueue("note", "a");
  // In flight.
  assert.equal(queue.isIdle("note"), false);
  await settle();
  await settle();
  // Waiting to retry.
  assert.equal(queue.isIdle("note"), false);
  assert.equal(queue.isIdle("other"), true);
  await queue.flush();
  assert.equal(queue.isIdle("note"), true);
});

test("modules save independently and a dropped module stops retrying", async () => {
  const { queue, persisted, fail } = setup();
  fail(1);
  queue.enqueue("deleted", "x");
  queue.enqueue("note", "a");
  await settle();
  await settle();
  queue.drop("deleted");
  assert.equal(await queue.flush(), true);
  assert.deepEqual(persisted, ["note:a"]);
  assert.equal(queue.isEmpty(), true);
});

test("clear discards every module's pending updates", async () => {
  const { queue, persisted } = setup({ failures: 2 });
  queue.enqueue("a", "1");
  queue.enqueue("b", "2");
  await settle();
  await settle();
  queue.clear();
  assert.equal(queue.isEmpty(), true);
  assert.equal(await queue.flush(), true);
  assert.deepEqual(persisted, []);
  assert.deepEqual(queue.status(), { pending: 0, failing: false, lastError: null });
});
