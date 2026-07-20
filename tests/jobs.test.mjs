import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("claimed job preparation and generation share one terminal error boundary", () => {
  assert.match(source, /async function executeClaimedJob[\s\S]*try \{[\s\S]*getPendingJobInput[\s\S]*inflateJobInput[\s\S]*callImageGeneration[\s\S]*catch \(error\)/);
  assert.match(source, /const ownsClaim = current\?\.status === "running" && current\.claim_token === claimToken/);
  assert.match(source, /return await finish\("error", \{ detail \}\)/);
});

test("only a finalized claim removes temporary job assets", () => {
  assert.match(source, /if \(finalized\) await deleteJobTmpAssets\(env, claimed\.id\)/);
  assert.doesNotMatch(source, /stopExecutionMonitor\(\);\s*await deleteJobTmpAssets/);
});

test("an occupied SSE claim closes into polling without a fake terminal error", () => {
  assert.match(source, /if \(!claimed\) \{\s*sendEvent\("waiting", \{ reason: "another-worker-running" \}\);\s*return;/);
  assert.doesNotMatch(source, /Timed out waiting for worker/);
  assert.doesNotMatch(source, /for \(let i = 0; i < 60/);
});

test("scheduled cleanup does not share a subrequest budget with active generation", () => {
  assert.match(source, /if \(ids\.length === 0 && minute % 30 === 0\)/);
});
