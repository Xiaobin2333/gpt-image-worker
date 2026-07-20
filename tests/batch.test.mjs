import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("sequential image edits continue after individual failures", async () => {
  const proxy = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /if \(useSingleImagePerCall\) \{[\s\S]*single-image attempt failed, continuing batch[\s\S]*continue;/);
  assert.match(proxy, /if \(entries\.length === 0\) throw new Error\("Upstream produced no images"\)/);
});

test("Images API falls back when the upstream rejects tools[0].n", async () => {
  const proxy = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /function requiresSingleImageCalls[\s\S]*\^gpt-image-2[\s\S]*\.test\(payload\.model\.trim\(\)\)/);
  assert.match(proxy, /let useSingleImagePerCall = requiresSingleImageCalls\(payload\)/);
  assert.match(proxy, /if \(!useSingleImagePerCall && perCall > 1 && rejectsImageCountParameter\(e\)\) \{[\s\S]*useSingleImagePerCall = true[\s\S]*continue;/);
  assert.match(proxy, /const perCall = useSingleImagePerCall \? 1 : remaining/);
});

test("job image records share one guarded gallery batch", async () => {
  const proxy = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /const pendingEntries = entries\.filter[\s\S]*addGalleryEntriesForJob\([\s\S]*pendingEntries/);
  assert.match(proxy, /if \(!committed\)[\s\S]*deletePendingImages[\s\S]*Generation job lease lost/);
  assert.match(proxy, /if \(isFatalJobError\(e\)\) \{[\s\S]*throw e/);
});
