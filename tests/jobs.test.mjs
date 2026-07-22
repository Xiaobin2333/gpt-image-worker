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

test("an occupied SSE claim follows produced images until the terminal state", () => {
  assert.match(source, /const followClaimedJob = async \(reason: string\)[\s\S]*getJob\(env, jobId\)[\s\S]*current\.status === "success"[\s\S]*emitProducedImages\(current\)[\s\S]*sendEvent\("done"/);
  assert.match(source, /const freshIds = \(current\.produced_ids \?\? \[\]\)\.filter[\s\S]*listProducedEntries\(env, freshIds\)[\s\S]*sendEvent\("image"/);
  assert.match(source, /if \(!claimed\) \{\s*await followClaimedJob\("another-worker-running"\);\s*return;/);
  assert.match(source, /if \(!terminal\) await followClaimedJob\("job-lease-lost"\)/);
  assert.doesNotMatch(source, /Timed out waiting for worker/);
});

test("an abandoned SSE claim is reclaimed after its lease becomes stale", () => {
  assert.match(source, /const followClaimedJob = async \(reason: string\)[\s\S]*const reclaimed = await tryClaimJob\(env, jobId\)/);
  assert.match(source, /if \(reclaimed\) \{[\s\S]*executeStreamClaim\(reclaimed\)[\s\S]*job-lease-lost/);
  assert.match(source, /const terminal = await executeStreamClaim\(claimed\)[\s\S]*followClaimedJob\("job-lease-lost"\)/);
});

test("active job listings identify jobs owned by the current browser", () => {
  assert.match(source, /is_owner: !!owner && job\.owner_id === owner/);
});

test("scheduled cleanup does not share a subrequest budget with active generation", () => {
  assert.match(source, /if \(ids\.length === 0 && minute % 30 === 0\)/);
});
