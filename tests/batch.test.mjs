import assert from "node:assert/strict";
import test from "node:test";

import { runSettledBatch } from "../src/batch.ts";

test("runSettledBatch keeps successful images when one call fails", async () => {
  const started = [];
  const batch = await runSettledBatch(4, 2, async (index) => {
    started.push(index);
    if (index === 1) throw new Error("upstream 400");
    return `image-${index}`;
  });

  assert.deepEqual(started.sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.deepEqual(batch.results, ["image-0", "image-2", "image-3"]);
  assert.equal(batch.errors.length, 1);
  assert.equal(batch.errors[0].index, 1);
  assert.match(batch.errors[0].error.message, /400/);
});

test("runSettledBatch reports every failure when the whole batch fails", async () => {
  const batch = await runSettledBatch(3, 3, async (index) => {
    throw new Error(`failure-${index}`);
  });

  assert.deepEqual(batch.results, []);
  assert.deepEqual(batch.errors.map((item) => item.index), [0, 1, 2]);
});
